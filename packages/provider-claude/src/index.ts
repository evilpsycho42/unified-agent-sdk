import { randomUUID } from "node:crypto";
import {
  query as claudeQuery,
  type Options as ClaudeOptions,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type SDKResultError,
  type SDKResultMessage,
  type SDKResultSuccess,
} from "@anthropic-ai/claude-agent-sdk";
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

export const PROVIDER_CLAUDE_AGENT_SDK = "@anthropic-ai/claude-agent-sdk" as ProviderId;

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

type UnifiedOwnedClaudeOptionKeys = "cwd" | "additionalDirectories" | "resume" | "abortController" | "model";

export type ClaudeRuntimeConfig = {
  /**
   * Defaults applied to every `query()` call created by this runtime.
   * Unified-owned fields (workspace/resume/abort) are set by the adapter.
   */
  defaults?: Omit<ClaudeOptions, UnifiedOwnedClaudeOptionKeys>;
  /** Dependency injection for tests/advanced usage. */
  query?: typeof claudeQuery;
};

export type ClaudeSessionConfig = Omit<
  ClaudeOptions,
  UnifiedOwnedClaudeOptionKeys
> & {
  /**
   * If provided, will be mapped to Claude `options.resume` when creating a query.
   * This is the Claude session id.
   */
  resumeSessionId?: string;
};

export class ClaudeRuntime
  implements UnifiedAgentRuntime<ClaudeSessionConfig, Partial<ClaudeSessionConfig>>
{
  public readonly provider = PROVIDER_CLAUDE_AGENT_SDK;
  private readonly defaults?: ClaudeRuntimeConfig["defaults"];
  private readonly queryFn: typeof claudeQuery;

  constructor(config: ClaudeRuntimeConfig = {}) {
    this.defaults = config.defaults;
    this.queryFn = config.query ?? claudeQuery;
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      streamingOutput: true,
      structuredOutput: true,
      cancel: true,
      sessionResume: true,
      fileEvents: false,
      toolEvents: false,
      rawEvents: true,
    };
  }

  async openSession(init: {
    sessionId: string;
    config?: SessionConfig<ClaudeSessionConfig>;
  }): Promise<UnifiedSession<ClaudeSessionConfig, Partial<ClaudeSessionConfig>>> {
    const sessionProvider: ClaudeSessionConfig = init.config?.provider ?? ({} as ClaudeSessionConfig);
    return new ClaudeSession({
      sessionId: init.sessionId,
      workspace: init.config?.workspace,
      permissions: init.config?.permissions,
      model: init.config?.model,
      defaults: this.defaults,
      queryFn: this.queryFn,
      sessionProvider,
    });
  }

  async resumeSession(handle: SessionHandle): Promise<UnifiedSession<ClaudeSessionConfig, Partial<ClaudeSessionConfig>>> {
    if (!handle.nativeSessionId) {
      throw new Error("Claude resumeSession requires nativeSessionId (Claude session id).");
    }
    return new ClaudeSession({
      sessionId: handle.sessionId,
      workspace: undefined,
      permissions: undefined,
      defaults: this.defaults,
      queryFn: this.queryFn,
      sessionProvider: { resumeSessionId: handle.nativeSessionId } as ClaudeSessionConfig,
    });
  }

  async close(): Promise<void> {}
}

class ClaudeSession implements UnifiedSession<ClaudeSessionConfig, Partial<ClaudeSessionConfig>> {
  public readonly provider = PROVIDER_CLAUDE_AGENT_SDK;
  public readonly sessionId: string;
  public nativeSessionId?: string;

  private readonly workspace?: WorkspaceConfig;
  private readonly model?: string;
  private readonly defaults?: ClaudeRuntimeConfig["defaults"];
  private readonly queryFn: typeof claudeQuery;
  private readonly sessionProvider: ClaudeSessionConfig;
  private readonly permissions?: PermissionsConfig;
  private activeRunId: UUID | undefined;
  private readonly abortControllers = new Map<UUID, AbortController>();

  constructor(params: {
    sessionId: string;
    workspace?: WorkspaceConfig;
    permissions?: PermissionsConfig;
    model?: string;
    defaults?: ClaudeRuntimeConfig["defaults"];
    queryFn: typeof claudeQuery;
    sessionProvider: ClaudeSessionConfig;
  }) {
    this.sessionId = params.sessionId;
    this.workspace = params.workspace;
    this.permissions = params.permissions;
    this.model = params.model;
    this.defaults = params.defaults;
    this.queryFn = params.queryFn;
    this.sessionProvider = params.sessionProvider;
    this.nativeSessionId = params.sessionProvider.resumeSessionId;
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      streamingOutput: true,
      structuredOutput: true,
      cancel: true,
      sessionResume: true,
      fileEvents: false,
      toolEvents: false,
      rawEvents: true,
    };
  }

  async status(): Promise<SessionStatus> {
    return { state: this.activeRunId ? "running" : "idle", activeRunId: this.activeRunId };
  }

  async run(req: RunRequest<Partial<ClaudeSessionConfig>>): Promise<RunHandle> {
    if (this.activeRunId) throw new SessionBusyError(this.activeRunId);
    const runId = randomUUID() as UUID;

    const abortController = new AbortController();
    this.abortControllers.set(runId, abortController);
    if (req.config?.signal) {
      // Mirror external abort into the SDK abortController.
      req.config.signal.addEventListener("abort", () => abortController.abort(req.config?.signal?.reason), {
        once: true,
      });
    }

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
        for await (const ev of this.runEvents(runId, req, abortController, resolveResult)) {
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
            events.push({ type: "error", atMs: Date.now(), runId, message: formatFailedMessage("Claude run failed", error), raw: error });
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
    req: RunRequest<Partial<ClaudeSessionConfig>>,
    abortController: AbortController,
    resolveResult: (value: Extract<RuntimeEvent, { type: "run.completed" }>) => void,
  ): AsyncGenerator<RuntimeEvent> {
    const startedAt = Date.now();
    let completed = false;
    let finalText: string | undefined;
    let structuredOutput: unknown | undefined;

    const runProvider: Partial<ClaudeSessionConfig> = req.config?.provider ?? {};

    const unifiedPermissionOptions = this.permissions
      ? mapUnifiedPermissionsToClaude(this.permissions, {
          cwd: this.workspace?.cwd,
          additionalDirs: this.workspace?.additionalDirs,
        })
      : {};

    const { schemaForProvider, unwrapStructuredOutput } = normalizeStructuredOutputSchema(req.config?.outputSchema);

    const options: ClaudeOptions = {
      ...(this.defaults ?? {}),
      ...(this.sessionProvider ?? {}),
      ...(runProvider ?? {}),
      ...unifiedPermissionOptions,
      abortController,
      cwd: this.workspace?.cwd,
      additionalDirectories: this.workspace?.additionalDirs,
      resume: this.sessionProvider.resumeSessionId,
    };
    if (this.model) options.model = this.model;
    if (options.settingSources === undefined) options.settingSources = ["user", "project"];
    if (schemaForProvider) {
      options.outputFormat = { type: "json_schema", schema: schemaForProvider };
    }

    try {
      yield {
        type: "run.started",
        atMs: startedAt,
        provider: PROVIDER_CLAUDE_AGENT_SDK,
        sessionId: this.sessionId,
        nativeSessionId: this.nativeSessionId,
        runId,
      };

      const prompt = normalizePrompt(req);
      const q = this.queryFn({ prompt, options });

      for await (const msg of q) {
        this.nativeSessionId = (msg as { session_id?: string }).session_id ?? this.nativeSessionId;

        const mapped = mapClaudeMessage(runId, msg);
        for (const ev of mapped.events) yield ev;

        if (mapped.result) {
          finalText = mapped.result.finalText;
          structuredOutput = unwrapStructuredOutput(mapped.result.structuredOutput);
          const done: Extract<RuntimeEvent, { type: "run.completed" }> = {
            type: "run.completed",
            atMs: Date.now(),
            runId,
            status: mapped.result.status,
            finalText,
            structuredOutput,
            usage: mapped.result.usage,
            raw: msg,
          };
          completed = true;
          yield done;
          resolveResult(done);
          break;
        }

        if (mapped.events.length === 0) {
          yield {
            type: "provider.event",
            atMs: Date.now(),
            runId,
            provider: PROVIDER_CLAUDE_AGENT_SDK,
            payload: msg,
            raw: msg,
          };
        }
      }

      if (!completed && abortController.signal.aborted) {
        const done: Extract<RuntimeEvent, { type: "run.completed" }> = {
          type: "run.completed",
          atMs: Date.now(),
          runId,
          status: "cancelled",
          finalText,
        };
        completed = true;
        yield done;
        resolveResult(done);
      }

      if (!completed) {
        yield { type: "error", atMs: Date.now(), runId, message: "Claude stream ended without a result." };
        const done: Extract<RuntimeEvent, { type: "run.completed" }> = {
          type: "run.completed",
          atMs: Date.now(),
          runId,
          status: "error",
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
        // When Node spawn() fails due to a missing cwd, the error message often looks like:
        //   "Failed to spawn Claude Code process: spawn /path/to/node ENOENT"
        // which is misleading because the binary may exist.
        const workspaceHint =
          this.workspace?.cwd && typeof this.workspace.cwd === "string"
            ? ` (check workspace.cwd exists: ${this.workspace.cwd})`
            : "";
        yield {
          type: "error",
          atMs: Date.now(),
          runId,
          message: `${formatFailedMessage("Claude run failed", error)}${workspaceHint}`,
          raw: error,
        };
      }
      if (!completed) {
        const done: Extract<RuntimeEvent, { type: "run.completed" }> = {
          type: "run.completed",
          atMs: Date.now(),
          runId,
          status: cancelled ? "cancelled" : "error",
          finalText,
          structuredOutput,
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

  async cancel(runId?: UUID): Promise<void> {
    if (runId) {
      this.abortControllers.get(runId)?.abort();
      return;
    }
    for (const controller of this.abortControllers.values()) controller.abort();
  }

  async snapshot(): Promise<SessionHandle> {
    return { provider: PROVIDER_CLAUDE_AGENT_SDK, sessionId: this.sessionId, nativeSessionId: this.nativeSessionId };
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

function mapUnifiedPermissionsToClaude(
  input: PermissionsConfig,
  workspace: { cwd?: string; additionalDirs?: string[] } | undefined,
): Partial<ClaudeOptions> {
  const p = normalizePermissions(input);

  if (p.yolo) {
    return {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // Avoid conflicting with SDK-level prompt routing; YOLO means no prompts.
      permissionPromptToolName: undefined,
      canUseTool: undefined,
      sandbox: { enabled: false },
    };
  }

  // Non-interactive, no mid-run UX:
  // - Remove disallowed tools from the model context (`disallowedTools`).
  // - Provide a deterministic `canUseTool` gate so the SDK never blocks on interactive approvals.
  //
  // Note: This is deliberately conservative and coarse. Callers who want richer behavior can use provider config directly.
  const disallowedTools = ["AskUserQuestion"];
  if (!p.network) disallowedTools.push("WebFetch", "WebSearch");
  if (!p.write) disallowedTools.push("Write", "Edit", "NotebookEdit", "KillShell");

  return {
    permissionPromptToolName: undefined,
    permissionMode: "default",
    // Explicitly exclude mid-run interactive UX in the unified layer.
    disallowedTools,
    sandbox: { enabled: p.sandbox, autoAllowBashIfSandboxed: false },
    canUseTool: async (toolName, toolInput, meta) => {
      // Avoid hard-interrupting the whole run on policy denials; return an error tool result to the model
      // so it can respond gracefully (e.g. "I can't write files with the current permissions.").
      const deny = (message: string) => ({ behavior: "deny" as const, message, interrupt: false as const });
      if (disallowedTools.includes(toolName)) return deny(`Tool '${toolName}' is disabled by unified permissions.`);

      // Enforce "sandbox=true => restrict writes to workspace roots" (Codex-like).
      // Reads can still happen outside the workspace.
      if (p.sandbox && p.write) {
        const blockedPath = meta && typeof meta === "object" && "blockedPath" in meta ? (meta as { blockedPath?: unknown }).blockedPath : undefined;
        const requestedPath =
          toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) && "file_path" in toolInput
            ? (toolInput as { file_path?: unknown }).file_path
            : undefined;
        const path = typeof blockedPath === "string" && blockedPath ? blockedPath : typeof requestedPath === "string" && requestedPath ? requestedPath : undefined;

        const isWriteTarget = toolName === "Bash" ? isMutatingBashToolInput(toolInput) : isWriteLikeTool(toolName);
        if (path && isWriteTarget && !isPathWithinWorkspace(path, workspace)) {
          return deny(`Path '${path}' is outside the session workspace (permissions.sandbox=true).`);
        }
      }

      // write=false means: deny mutating tools, but allow read-only Bash commands.
      if (toolName === "Bash" && !p.write) {
        const command =
          toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) && "command" in toolInput
            ? (toolInput as { command?: unknown }).command
            : undefined;
        if (typeof command !== "string" || !command.trim()) return deny("Bash command is missing.");
        if (!isReadOnlyBashCommand(command, { allowNetwork: p.network })) {
          return deny("Bash command denied by unified permissions (write=false).");
        }
      }

      // Claude Code validates the permission response shape. Some builds expect `updatedInput`
      // to be present for "allow" decisions, so preserve the original tool input when possible.
      const updatedInput =
        toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) ? (toolInput as Record<string, unknown>) : {};
      return { behavior: "allow" as const, updatedInput };
    },
  };
}

function isWriteLikeTool(toolName: string): boolean {
  return toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit";
}

function isPathWithinWorkspace(path: string, workspace: { cwd?: string; additionalDirs?: string[] } | undefined): boolean {
  if (!workspace) return true;
  const roots: string[] = [];
  if (typeof workspace.cwd === "string" && workspace.cwd) roots.push(workspace.cwd);
  if (Array.isArray(workspace.additionalDirs)) {
    for (const d of workspace.additionalDirs) if (typeof d === "string" && d) roots.push(d);
  }
  if (roots.length === 0) return true;

  // Treat the roots as string-prefix matches. This is best-effort (Claude Code itself performs the authoritative path resolution).
  return roots.some((r) => path === r || path.startsWith(r.endsWith("/") ? r : `${r}/`));
}

function isMutatingBashToolInput(toolInput: unknown): boolean {
  const command =
    toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) && "command" in toolInput
      ? (toolInput as { command?: unknown }).command
      : undefined;
  if (typeof command !== "string" || !command.trim()) return false;
  // This intentionally matches the "definitely mutating" patterns from `isReadOnlyBashCommand`.
  if (/[><]|\\btee\\b/.test(command)) return true;
  if (/\\b(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|chgrp|ln|dd|truncate|kill|pkill|xargs)\\b/.test(command)) return true;
  if (/\\b(sed\\s+-i|perl\\s+-i|python\\s+-c|node\\s+-e)\\b/.test(command)) return true;
  if (/\\b(git\\s+(commit|push|checkout|switch|reset|clean|rebase|merge|apply|cherry-pick|tag|stash))\\b/.test(command)) return true;
  return false;
}

function isReadOnlyBashCommand(command: string, opts: { allowNetwork: boolean }): boolean {
  const c = command.trim();
  if (!c) return false;

  // Deny obvious shell operators that frequently indicate mutation or complex execution.
  // This is intentionally conservative.
  if (/[><]|\\btee\\b/.test(c)) return false;

  // Deny common mutating commands.
  if (/\b(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|chgrp|ln|dd|truncate|kill|pkill|xargs)\b/.test(c)) return false;
  if (/\b(sed\s+-i|perl\s+-i|python\s+-c|node\s+-e)\b/.test(c)) return false;
  if (/\b(git\s+(commit|push|checkout|switch|reset|clean|rebase|merge|apply|cherry-pick|tag|stash))\b/.test(c)) return false;

  // Network-sensitive commands.
  if (!opts.allowNetwork) {
    if (/\b(curl|wget|nc|ncat|ssh|scp|sftp|rsync)\b/.test(c)) return false;
    if (/\b(git\s+(clone|fetch|pull))\b/.test(c)) return false;
  }

  // Allow a small set of read-only commands (including common search).
  // Note: `git` is allowed only for read-only verbs here.
  if (/^\s*(ls|pwd|whoami|id|uname)\b/.test(c)) return true;
  if (/^\s*(cat|head|tail|wc|stat)\b/.test(c)) return true;
  if (/^\s*(rg|grep|find)\b/.test(c)) return true;
  if (/^\s*git\s+(status|diff|log|show)\b/.test(c)) return true;

  return false;
}

function normalizePrompt<TRunProvider>(req: RunRequest<TRunProvider>): string {
  if (isAsyncIterable(req.input)) {
    throw new Error("Claude adapter streaming input (AsyncIterable<TurnInput>) is not implemented yet.");
  }
  const turns = Array.isArray(req.input) ? req.input : [req.input];
  for (const turn of turns) {
    for (const part of turn.parts) {
      if (part.type !== "text") throw new Error(`Unsupported content part for Claude adapter: ${part.type}`);
    }
  }
  return turns.map(asText).join("\n\n");
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof (value as AsyncIterable<unknown> | null)?.[Symbol.asyncIterator] === "function";
}

function mapClaudeMessage(
  runId: UUID,
  msg: SDKMessage,
): {
  events: RuntimeEvent[];
  result?: {
    status: "success" | "error";
    finalText?: string;
    structuredOutput?: unknown;
    usage?: { costUsd?: number; durationMs?: number; inputTokens?: number; outputTokens?: number; raw?: unknown };
  };
} {
  if (msg.type === "stream_event") {
    const delta = extractTextDelta(msg as SDKPartialAssistantMessage);
    if (delta) {
      return { events: [{ type: "assistant.delta", atMs: Date.now(), runId, textDelta: delta, raw: msg }] };
    }
    return { events: [] };
  }

  if (msg.type === "assistant") {
    const text = extractAssistantText(msg as SDKAssistantMessage);
    if (text) {
      return {
        events: [
          {
            type: "assistant.message",
            atMs: Date.now(),
            runId,
            message: { text },
            raw: msg,
          },
        ],
      };
    }
    return { events: [] };
  }

  if (msg.type === "result") {
    const r = msg as SDKResultMessage;
    if (r.subtype === "success") {
      const success = r as SDKResultSuccess;
      return {
        events: [],
        result: {
          status: "success",
          finalText: success.result,
          structuredOutput: success.structured_output,
          usage: {
            costUsd: success.total_cost_usd,
            durationMs: success.duration_ms,
            raw: success.usage,
          },
        },
      };
    }

    const error = r as SDKResultError;
    return {
      events: [],
      result: {
        status: "error",
        finalText: error.errors?.join("\n") ?? undefined,
        usage: { costUsd: error.total_cost_usd, durationMs: error.duration_ms, raw: error.usage },
      },
    };
  }

  return { events: [] };
}

function extractTextDelta(msg: SDKPartialAssistantMessage): string | null {
  const ev = msg.event as unknown as { type?: string; delta?: { type?: string; text?: string } };
  if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
    return ev.delta.text;
  }
  return null;
}

function extractAssistantText(msg: SDKAssistantMessage): string | null {
  const m = msg.message as unknown as { content?: unknown };
  const content = m?.content;
  if (!Array.isArray(content)) return null;
  const texts = content
    .map((b) => (b && typeof b === "object" ? (b as { type?: string; text?: string }).type === "text" ? (b as { text?: string }).text : undefined : undefined))
    .filter((t): t is string => typeof t === "string");
  return texts.length ? texts.join("") : null;
}

function normalizeStructuredOutputSchema(
  schema: Record<string, unknown> | undefined,
): { schemaForProvider: Record<string, unknown> | undefined; unwrapStructuredOutput: (value: unknown) => unknown } {
  if (!schema) {
    return { schemaForProvider: schema, unwrapStructuredOutput: (value) => value };
  }

  // Claude Code's `--json-schema` is most reliable when the schema root is an object.
  // Wrap non-object roots (like top-level arrays) and unwrap results back to the requested shape.
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
