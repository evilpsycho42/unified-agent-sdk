import { randomUUID } from "node:crypto";
import { Codex, type CodexOptions, type Thread, type ThreadEvent, type ThreadOptions } from "@openai/codex-sdk";
import type {
  PermissionsConfig,
  ProviderId,
  RunHandle,
  RunRequest,
  RuntimeCapabilities,
  RuntimeEvent,
  SessionConfig,
  SessionHandle,
  SessionStatus,
  UnifiedAgentRuntime,
  UnifiedSession,
  UUID,
  WorkspaceConfig,
} from "@unified-agent-sdk/runtime-core";
import { asText, SessionBusyError } from "@unified-agent-sdk/runtime-core";

export const PROVIDER_CODEX_SDK = "@openai/codex-sdk" as ProviderId;

class AsyncEventStream<T> implements AsyncIterable<T> {
  private readonly maxBuffer: number;
  private readonly buffer: T[] = [];
  private readonly pending: Array<(result: IteratorResult<T, void>) => void> = [];
  private closed = false;
  private iteratorCreated = false;

  constructor(opts?: { maxBuffer?: number }) {
    this.maxBuffer = opts?.maxBuffer ?? 2048;
  }

  push(value: T): void {
    if (this.closed) return;
    const resolve = this.pending.shift();
    if (resolve) {
      resolve({ value, done: false });
      return;
    }
    this.buffer.push(value);
    if (this.buffer.length > this.maxBuffer) this.buffer.shift();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.pending.length) {
      const resolve = this.pending.shift();
      if (resolve) resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T, void, void> {
    if (this.iteratorCreated) {
      throw new Error("RunHandle.events can only be consumed once.");
    }
    this.iteratorCreated = true;

    return {
      next: async () => {
        if (this.buffer.length) return { value: this.buffer.shift() as T, done: false };
        if (this.closed) return { value: undefined, done: true };
        return await new Promise<IteratorResult<T, void>>((resolve) => this.pending.push(resolve));
      },
      return: async () => {
        this.buffer.length = 0;
        this.close();
        return { value: undefined, done: true };
      },
    };
  }
}

type UnifiedOwnedCodexKeys = "workingDirectory" | "additionalDirectories" | "model";
export type CodexSessionConfig = Omit<ThreadOptions, UnifiedOwnedCodexKeys>;

export type CodexRuntimeConfig = {
  /**
   * Client-level Codex SDK options (apiKey/baseUrl/env/codexPathOverride).
   * This matches the upstream `new Codex(options)` constructor.
   */
  client?: CodexOptions;
  /** Defaults applied to every thread created/resumed by this runtime. */
  defaults?: ThreadOptions;
  /** Dependency injection for tests/advanced usage. */
  codex?: Codex;
  /**
   * Deprecated alias (kept for compatibility within this repo's early development).
   * Prefer `client`.
   */
  codexOptions?: CodexOptions;
};

export class CodexRuntime implements UnifiedAgentRuntime<CodexSessionConfig, never> {
  public readonly provider = PROVIDER_CODEX_SDK;
  private readonly codex: Codex;
  private readonly defaults?: ThreadOptions;

  constructor(config: CodexRuntimeConfig = {}) {
    const client = config.client ?? config.codexOptions;
    this.codex = config.codex ?? new Codex(client);
    this.defaults = config.defaults;
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      streamingOutput: true,
      structuredOutput: true,
      cancel: true,
      sessionResume: true,
      fileEvents: true,
      toolEvents: true,
      rawEvents: true,
    };
  }

  async openSession(init: {
    sessionId: string;
    config?: SessionConfig<CodexSessionConfig>;
  }): Promise<UnifiedSession<CodexSessionConfig, never>> {
    const provider: CodexSessionConfig = init.config?.provider ?? {};
    const permissions = init.config?.permissions;
    const permissionOptions = permissions ? mapUnifiedPermissionsToCodex(permissions) : {};
    const model = init.config?.model;
    const threadOptions: ThreadOptions = {
      ...(this.defaults ?? {}),
      ...provider,
      ...(model ? { model } : {}),
      ...(init.config?.workspace && {
        workingDirectory: init.config.workspace.cwd,
        additionalDirectories: init.config.workspace.additionalDirs,
      }),
      ...permissionOptions,
    };
    const thread = this.codex.startThread(threadOptions);
    return new CodexSession({ sessionId: init.sessionId, thread });
  }

  async resumeSession(handle: SessionHandle): Promise<UnifiedSession<CodexSessionConfig, never>> {
    if (!handle.nativeSessionId) {
      throw new Error("Codex resumeSession requires nativeSessionId (thread id).");
    }
    const thread = this.codex.resumeThread(handle.nativeSessionId, this.defaults ?? {});
    return new CodexSession({ sessionId: handle.sessionId, thread });
  }

  async close(): Promise<void> {}
}

class CodexSession implements UnifiedSession<CodexSessionConfig, never> {
  public readonly provider = PROVIDER_CODEX_SDK;
  public readonly sessionId: string;
  public nativeSessionId?: string;

  private readonly thread: Thread;
  private activeRunId: UUID | undefined;
  private readonly abortControllers = new Map<UUID, AbortController>();

  constructor(params: { sessionId: string; thread: Thread }) {
    this.sessionId = params.sessionId;
    this.thread = params.thread;
    this.nativeSessionId = this.thread.id ?? undefined;
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      streamingOutput: true,
      structuredOutput: true,
      cancel: true,
      sessionResume: true,
      fileEvents: true,
      toolEvents: true,
      rawEvents: true,
    };
  }

  async status(): Promise<SessionStatus> {
    return { state: this.activeRunId ? "running" : "idle", activeRunId: this.activeRunId };
  }

  async run(req: RunRequest<never>): Promise<RunHandle> {
    if (this.activeRunId) throw new SessionBusyError(this.activeRunId);
    const runId = randomUUID() as UUID;

    const { input, images } = normalizeRunInput(req);
    const abortController = new AbortController();
    this.abortControllers.set(runId, abortController);
    if (req.config?.signal) {
      req.config.signal.addEventListener("abort", () => abortController.abort(req.config?.signal?.reason), { once: true });
    }
    const { schemaForProvider, unwrapStructuredOutput } = normalizeStructuredOutputSchema(req.config?.outputSchema);
    const turnOptions = { outputSchema: schemaForProvider, signal: abortController.signal };

    let resolveResult!: (value: Extract<RuntimeEvent, { type: "run.completed" }>) => void;
    let resultResolved = false;
    const result = new Promise<Extract<RuntimeEvent, { type: "run.completed" }>>((resolve) => {
      resolveResult = (value) => {
        resultResolved = true;
        resolve(value);
      };
    });

    this.activeRunId = runId;
    const events = new AsyncEventStream<RuntimeEvent>();
    void (async () => {
      try {
        for await (const ev of this.runEvents(
          runId,
          input,
          images,
          turnOptions,
          unwrapStructuredOutput,
          resolveResult,
          abortController,
        )) {
          events.push(ev);
          if (ev.type === "run.completed") {
            this.abortControllers.delete(runId);
            if (this.activeRunId === runId) this.activeRunId = undefined;
          }
        }
      } catch (error) {
        if (!resultResolved) {
          const cancelled = abortController.signal.aborted;
          const done: Extract<RuntimeEvent, { type: "run.completed" }> = {
            type: "run.completed",
            atMs: Date.now(),
            runId,
            status: cancelled ? "cancelled" : "error",
            raw: error,
          };
          if (!cancelled) {
            events.push({ type: "error", atMs: Date.now(), runId, message: formatFailedMessage("Codex run failed", error), raw: error });
          }
          events.push(done);
          resolveResult(done);
        }
      } finally {
        this.abortControllers.delete(runId);
        if (this.activeRunId === runId) this.activeRunId = undefined;
        events.close();
      }
    })();

    return {
      runId,
      events,
      result,
      cancel: async () => abortController.abort(),
    };
  }

  private async *runEvents(
    runId: UUID,
    input: string,
    images: string[],
    turnOptions: { outputSchema?: unknown; signal?: AbortSignal },
    unwrapStructuredOutput: (value: unknown) => unknown,
    resolveResult: (value: Extract<RuntimeEvent, { type: "run.completed" }>) => void,
    abortController: AbortController,
  ): AsyncGenerator<RuntimeEvent> {
    const startedAt = Date.now();
    let finalText: string | undefined;
    let completed = false;

    try {
      yield {
        type: "run.started",
        atMs: startedAt,
        provider: PROVIDER_CODEX_SDK,
        sessionId: this.sessionId,
        nativeSessionId: this.nativeSessionId,
        runId,
      };

      const codexInput = images.length
        ? [
            { type: "text" as const, text: input },
            ...images.map((path) => ({ type: "local_image" as const, path })),
          ]
        : input;

      const streamed = await this.thread.runStreamed(codexInput, turnOptions);
      for await (const ev of streamed.events) {
        yield* this.mapEvent(runId, ev, (t) => {
          finalText = t;
        });

        if (ev.type === "thread.started") {
          this.nativeSessionId = ev.thread_id;
        }

        if (ev.type === "turn.completed") {
          const u = {
            inputTokens: ev.usage.input_tokens,
            outputTokens: ev.usage.output_tokens,
            totalTokens: ev.usage.input_tokens + ev.usage.output_tokens,
            raw: ev.usage,
          };
          const parsed = turnOptions.outputSchema && typeof finalText === "string" ? tryParseJson(finalText) : undefined;
          const structuredOutput = parsed === undefined ? undefined : unwrapStructuredOutput(parsed);
          const done: Extract<RuntimeEvent, { type: "run.completed" }> = {
            type: "run.completed",
            atMs: Date.now(),
            runId,
            status: "success",
            finalText,
            structuredOutput,
            usage: u,
            raw: ev,
          };
          completed = true;
          yield done;
          resolveResult(done);
          break;
        }

        if (ev.type === "turn.failed") {
          const done: Extract<RuntimeEvent, { type: "run.completed" }> = {
            type: "run.completed",
            atMs: Date.now(),
            runId,
            status: abortController.signal.aborted ? "cancelled" : "error",
            finalText,
            raw: ev,
          };
          completed = true;
          yield done;
          resolveResult(done);
          break;
        }

        if (ev.type === "error") {
          if (!abortController.signal.aborted) {
            yield { type: "error", atMs: Date.now(), runId, message: ev.message, raw: ev };
          }
          const done: Extract<RuntimeEvent, { type: "run.completed" }> = {
            type: "run.completed",
            atMs: Date.now(),
            runId,
            status: abortController.signal.aborted ? "cancelled" : "error",
            finalText,
            raw: ev,
          };
          completed = true;
          yield done;
          resolveResult(done);
          break;
        }
      }
      if (!completed) {
        const cancelled = abortController.signal.aborted;
        if (!cancelled) {
          yield { type: "error", atMs: Date.now(), runId, message: "Codex stream ended without completion." };
        }
        const parsed = turnOptions.outputSchema && typeof finalText === "string" ? tryParseJson(finalText) : undefined;
        const structuredOutput = parsed === undefined ? undefined : unwrapStructuredOutput(parsed);
        const done: Extract<RuntimeEvent, { type: "run.completed" }> = {
          type: "run.completed",
          atMs: Date.now(),
          runId,
          status: cancelled ? "cancelled" : "error",
          finalText,
          structuredOutput,
        };
        completed = true;
        yield done;
        resolveResult(done);
      }
    } catch (error) {
      const cancelled = abortController.signal.aborted;
      if (!cancelled) {
        yield { type: "error", atMs: Date.now(), runId, message: formatFailedMessage("Codex run failed", error), raw: error };
      }
      if (!completed) {
        const done: Extract<RuntimeEvent, { type: "run.completed" }> = {
          type: "run.completed",
          atMs: Date.now(),
          runId,
          status: cancelled ? "cancelled" : "error",
          finalText,
          raw: error,
        };
        yield done;
        resolveResult(done);
      }
    } finally {
      this.abortControllers.delete(runId);
      if (this.activeRunId === runId) this.activeRunId = undefined;
    }
  }

  private *mapEvent(
    runId: UUID,
    ev: ThreadEvent,
    setFinalText: (text: string) => void,
  ): Generator<RuntimeEvent> {
    if (ev.type === "item.started") {
      const item = ev.item;
      if (item.type === "command_execution") {
        yield {
          type: "tool.call",
          atMs: Date.now(),
          runId,
          callId: item.id as UUID,
          toolName: "Bash",
          input: { command: item.command },
          raw: ev,
        };
        return;
      }
      if (item.type === "mcp_tool_call") {
        yield {
          type: "tool.call",
          atMs: Date.now(),
          runId,
          callId: item.id as UUID,
          toolName: `${item.server}.${item.tool}`,
          input: item.arguments,
          raw: ev,
        };
        return;
      }
      if (item.type === "web_search") {
        yield {
          type: "tool.call",
          atMs: Date.now(),
          runId,
          callId: item.id as UUID,
          toolName: "WebSearch",
          input: { query: item.query },
          raw: ev,
        };
        return;
      }
    }

    if (ev.type === "item.completed") {
      const item = ev.item;
      if (item.type === "agent_message") {
        setFinalText(item.text);
        yield {
          type: "assistant.message",
          atMs: Date.now(),
          runId,
          message: { text: item.text },
          raw: ev,
        };
        return;
      }

      if (item.type === "file_change") {
        if (item.status === "completed") {
          for (const change of item.changes) {
            yield {
              type: "file.changed",
              atMs: Date.now(),
              runId,
              change: {
                path: change.path,
                kind:
                  change.kind === "add" || change.kind === "delete" || change.kind === "update"
                    ? change.kind
                    : "unknown",
              },
              raw: ev,
            };
          }
          return;
        }
        yield { type: "error", atMs: Date.now(), runId, message: "Codex file change patch failed.", raw: ev };
        return;
      }

      if (item.type === "command_execution") {
        yield {
          type: "tool.result",
          atMs: Date.now(),
          runId,
          callId: item.id as UUID,
          output: {
            command: item.command,
            aggregatedOutput: item.aggregated_output,
            exitCode: item.exit_code,
            status: item.status,
          },
          raw: ev,
        };
        return;
      }

      if (item.type === "mcp_tool_call") {
        yield {
          type: "tool.result",
          atMs: Date.now(),
          runId,
          callId: item.id as UUID,
          output: item.result ?? item.error ?? null,
          raw: ev,
        };
        return;
      }

      if (item.type === "web_search") {
        yield {
          type: "tool.result",
          atMs: Date.now(),
          runId,
          callId: item.id as UUID,
          output: { query: item.query },
          raw: ev,
        };
        return;
      }
    }

    // Keep raw provider event available for advanced consumers.
    yield { type: "provider.event", atMs: Date.now(), runId, provider: PROVIDER_CODEX_SDK, payload: ev, raw: ev };
  }

  async cancel(runId?: UUID): Promise<void> {
    if (runId) {
      this.abortControllers.get(runId)?.abort();
      return;
    }
    for (const controller of this.abortControllers.values()) controller.abort();
  }

  async snapshot(): Promise<SessionHandle> {
    return { provider: PROVIDER_CODEX_SDK, sessionId: this.sessionId, nativeSessionId: this.nativeSessionId };
  }

  async dispose(): Promise<void> {}
}

function formatFailedMessage(prefix: string, error: unknown): string {
  const detail = describeUnknownError(error);
  if (!detail) return `${prefix}.`;
  return `${prefix}: ${detail}`;
}

function describeUnknownError(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return truncate(String((error as { message: string }).message));
  }
  if (error instanceof Error && typeof error.message === "string" && error.message) {
    return truncate(error.message);
  }
  try {
    return truncate(JSON.stringify(error));
  } catch {
    return truncate(String(error));
  }
}

function truncate(text: string, maxLen = 500): string {
  const t = text.trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen)}…`;
}

function normalizePermissions(input: PermissionsConfig): Required<PermissionsConfig> {
  const yolo = Boolean(input.yolo);
  return {
    yolo,
    network: yolo ? true : Boolean(input.network),
    write: yolo ? true : Boolean(input.write),
    sandbox: yolo ? false : Boolean(input.sandbox),
  };
}

function mapUnifiedPermissionsToCodex(input: PermissionsConfig): Partial<ThreadOptions> {
  const p = normalizePermissions(input);

  // Disable interactive approvals entirely; rely on sandbox/write/network constraints instead.
  const approvalPolicy: ThreadOptions["approvalPolicy"] = "never";

  // Codex uses sandbox modes as the primary enforcement mechanism.
  //
  // Mapping:
  // - sandbox=true,  write=false => read-only
  // - sandbox=true,  write=true  => workspace-write
  // - sandbox=false, write=true  => danger-full-access (unsafe; effectively YOLO-like)
  // - sandbox=false, write=false => force read-only (cannot express "no sandbox but no writes" safely)
  //
  // Note: `danger-full-access` implies broad access regardless of other toggles in some Codex builds.
  const sandboxMode: ThreadOptions["sandboxMode"] = p.yolo
    ? "danger-full-access"
    : !p.write
      ? "read-only"
      : p.sandbox
        ? "workspace-write"
        : "danger-full-access";

  return {
    approvalPolicy,
    sandboxMode,
    networkAccessEnabled: p.network,
    // Web search requires network; treat it as part of the unified `network` flag.
    webSearchEnabled: p.network,
  };
}

function normalizeRunInput<TRunProvider>(req: RunRequest<TRunProvider>): { input: string; images: string[] } {
  if (isAsyncIterable(req.input)) {
    throw new Error("Codex adapter does not support streaming input (AsyncIterable<TurnInput>) yet.");
  }
  const turns = Array.isArray(req.input) ? req.input : [req.input];
  const merged = turns.map(asText).join("\n\n");
  const images: string[] = [];
  for (const turn of turns) {
    for (const part of turn.parts) {
      if (part.type === "local_image") images.push(part.path);
      if (part.type !== "text" && part.type !== "local_image") {
        throw new Error(`Unsupported content part for Codex adapter: ${(part as { type: string }).type}`);
      }
    }
  }
  return { input: merged, images };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof (value as AsyncIterable<unknown> | null)?.[Symbol.asyncIterator] === "function";
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeStructuredOutputSchema(
  schema: Record<string, unknown> | undefined,
): { schemaForProvider: Record<string, unknown> | undefined; unwrapStructuredOutput: (value: unknown) => unknown } {
  if (!schema) {
    return { schemaForProvider: schema, unwrapStructuredOutput: (value) => value };
  }

  // OpenAI-style structured outputs are most reliable when the schema root is an object.
  // If the user asks for a non-object root (e.g. a top-level array), wrap it so providers
  // can enforce a single JSON object response and then unwrap it back to the requested shape.
  const rootType = (schema as { type?: unknown }).type;
  if (rootType === "object") {
    return { schemaForProvider: schema, unwrapStructuredOutput: (value) => value };
  }

  const wrapped = {
    type: "object",
    properties: { value: schema },
    required: ["value"],
    additionalProperties: false,
  };

  return {
    schemaForProvider: wrapped,
    unwrapStructuredOutput: (value) => {
      if (value && typeof value === "object" && !Array.isArray(value) && "value" in value) {
        return (value as { value?: unknown }).value;
      }
      return value;
    },
  };
}
