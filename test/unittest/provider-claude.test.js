import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeRuntime } from "@unified-agent-sdk/provider-claude";
import { SessionBusyError } from "@unified-agent-sdk/runtime-core";

test("ClaudeSession.cancel(runId) aborts the run and reports cancelled", async () => {
  const runtime = new ClaudeRuntime({
    query: ({ options }) =>
      (async function* () {
        const signal = options.abortController.signal;
        yield {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
        };
        if (signal.aborted) return;
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      })(),
  });

  const session = await runtime.openSession({ sessionId: "s1", config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });

  const events = [];
  for await (const ev of run.events) {
    events.push(ev);
    if (ev.type === "assistant.delta") await session.cancel(run.runId);
  }

  const done = events.find((e) => e.type === "run.completed");
  assert.ok(done, "expected run.completed event");
  assert.equal(done.status, "cancelled");
});

test("Claude adapter resolves run.result even when events are not consumed", async () => {
  const runtime = new ClaudeRuntime({
    query: () =>
      (async function* () {
        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          structured_output: { status: "ok" },
          total_cost_usd: 0,
          duration_ms: 1,
          usage: {},
        };
      })(),
  });

  const session = await runtime.openSession({ sessionId: "s_result_only", config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });

  const done = await run.result;
  assert.equal(done.type, "run.completed");
  assert.equal(done.status, "success");
  assert.equal((await session.status()).state, "idle");
});

test("ClaudeSession.run rejects concurrent runs (SessionBusyError)", async () => {
  const runtime = new ClaudeRuntime({
    query: ({ options }) =>
      (async function* () {
        const signal = options.abortController.signal;
        yield {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
        };
        if (signal.aborted) return;
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      })(),
  });

  const session = await runtime.openSession({ sessionId: "s_busy", config: { workspace: { cwd: process.cwd() } } });
  const run1 = await session.run({ input: { parts: [{ type: "text", text: "first" }] } });

  await assert.rejects(
    () => session.run({ input: { parts: [{ type: "text", text: "second" }] } }),
    (e) => e instanceof SessionBusyError && e.activeRunId === run1.runId,
  );

  await run1.cancel();
  const done = await run1.result;
  assert.equal(done.status, "cancelled");
});

test("Claude adapter forwards structured_output from SDK result", async () => {
  const runtime = new ClaudeRuntime({
    query: () =>
      (async function* () {
        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          structured_output: { status: "ok" },
          total_cost_usd: 0,
          duration_ms: 1,
          usage: {},
        };
      })(),
  });

  const session = await runtime.openSession({ sessionId: "s2", config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });

  let done;
  for await (const ev of run.events) {
    if (ev.type === "run.completed") done = ev;
  }

  assert.ok(done, "expected run.completed event");
  assert.equal(done.status, "success");
  assert.deepEqual(done.structuredOutput, { status: "ok" });
});

test("Claude adapter wraps non-object outputSchema roots and unwraps structuredOutput", async () => {
  const runtime = new ClaudeRuntime({
    query: ({ options }) =>
      (async function* () {
        assert.equal(options.outputFormat?.type, "json_schema");
        assert.ok(options.outputFormat && options.outputFormat.schema && options.outputFormat.schema.type === "object");

        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          structured_output: { value: [1, 2, 3] },
          total_cost_usd: 0,
          duration_ms: 1,
          usage: {},
        };
      })(),
  });

  const session = await runtime.openSession({ sessionId: "s2_array", config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({
    input: { parts: [{ type: "text", text: "hello" }] },
    config: { outputSchema: { type: "array", items: { type: "integer" } } },
  });

  let done;
  for await (const ev of run.events) {
    if (ev.type === "run.completed") done = ev;
  }

  assert.ok(done, "expected run.completed event");
  assert.equal(done.status, "success");
  assert.deepEqual(done.structuredOutput, [1, 2, 3]);
});

test("Claude adapter maps unified SessionConfig.permissions into Claude options (2x2x2 + yolo)", async (t) => {
  const cases = [];
  for (const network of [false, true]) {
    for (const sandbox of [false, true]) {
      for (const write of [false, true]) {
        cases.push({ name: `network=${network} sandbox=${sandbox} write=${write}`, permissions: { network, sandbox, write } });
      }
    }
  }
  cases.push({ name: "yolo", permissions: { yolo: true } });

  for (const c of cases) {
    await t.test(c.name, async () => {
      const runtime = new ClaudeRuntime({
        query: ({ options }) =>
          (async function* () {
            const yolo = Boolean(c.permissions.yolo);
            const expectedNetwork = yolo ? true : Boolean(c.permissions.network);
            const expectedWrite = yolo ? true : Boolean(c.permissions.write);
            const expectedSandbox = yolo ? false : Boolean(c.permissions.sandbox);

            if (yolo) {
              assert.equal(options.permissionMode, "bypassPermissions");
              assert.equal(options.allowDangerouslySkipPermissions, true);
              assert.equal(options.sandbox?.enabled, false);
              assert.equal(options.canUseTool, undefined);
              assert.equal(options.permissionPromptToolName, undefined);
            } else {
              assert.equal(options.permissionMode, "default");
              assert.equal(options.sandbox?.enabled, expectedSandbox);
              assert.equal(options.sandbox?.autoAllowBashIfSandboxed, false);
              assert.equal(typeof options.canUseTool, "function");
              assert.equal(options.permissionPromptToolName, undefined);

              assert.ok(Array.isArray(options.disallowedTools));
              assert.ok(options.disallowedTools.includes("AskUserQuestion"));

              const decisionFor = async (toolName, toolInput = {}) => options.canUseTool(toolName, toolInput, {});

              assert.equal((await decisionFor("AskUserQuestion")).behavior, "deny");
              assert.equal((await decisionFor("WebFetch")).behavior, expectedNetwork ? "allow" : "deny");
              assert.equal((await decisionFor("WebSearch")).behavior, expectedNetwork ? "allow" : "deny");

              assert.equal((await decisionFor("Read")).behavior, "allow");
              assert.equal((await decisionFor("Grep")).behavior, "allow");

              assert.equal((await decisionFor("Write")).behavior, expectedWrite ? "allow" : "deny");
              assert.equal((await decisionFor("Edit")).behavior, expectedWrite ? "allow" : "deny");
              assert.equal((await decisionFor("Bash", { command: "rg -n hello README.md" })).behavior, "allow");
              const bashDenied = await decisionFor("Bash", { command: "echo hi > /tmp/x" });
              assert.equal(bashDenied.behavior, expectedWrite ? "allow" : "deny");
              if (!expectedWrite) assert.equal(bashDenied.interrupt, false);
            }

            yield {
              type: "result",
              subtype: "success",
              result: "ok",
              structured_output: { ok: true },
              total_cost_usd: 0,
              duration_ms: 1,
              usage: {},
            };
          })(),
      });

      const session = await runtime.openSession({
        sessionId: "s_perm",
        config: { workspace: { cwd: process.cwd() }, permissions: c.permissions },
      });
      const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });

      let done;
      for await (const ev of run.events) {
        if (ev.type === "run.completed") done = ev;
      }

      assert.ok(done, "expected run.completed event");
      assert.equal(done.status, "success");
      assert.deepEqual(done.structuredOutput, { ok: true });
    });
  }
});

test("Claude adapter denies out-of-workspace writes when sandbox=true (but allows reads elsewhere)", async () => {
  const runtime = new ClaudeRuntime({
    query: ({ options }) =>
      (async function* () {
        assert.equal(typeof options.canUseTool, "function");

        const allowed = await options.canUseTool(
          "Write",
          { file_path: `${process.cwd()}/story.md`, content: "hi" },
          { blockedPath: `${process.cwd()}/story.md` },
        );
        assert.equal(allowed.behavior, "allow");

        const denied = await options.canUseTool(
          "Write",
          { file_path: "/tmp/outside.md", content: "nope" },
          { blockedPath: "/tmp/outside.md" },
        );
        assert.equal(denied.behavior, "deny");

        const readOutside = await options.canUseTool("Read", { file_path: "/etc/hosts" }, { blockedPath: "/etc/hosts" });
        assert.equal(readOutside.behavior, "allow");

        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          structured_output: { ok: true },
          total_cost_usd: 0,
          duration_ms: 1,
          usage: {},
        };
      })(),
  });

  const session = await runtime.openSession({
    sessionId: "s_sandbox_scope",
    config: { workspace: { cwd: process.cwd() }, permissions: { sandbox: true, write: true, network: false } },
  });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });
  for await (const _ev of run.events) {
    // drain
  }
});

test("Claude adapter defaults settingSources to ['user','project'] when omitted", async () => {
  const runtime = new ClaudeRuntime({
    query: ({ options }) =>
      (async function* () {
        assert.deepEqual(options.settingSources, ["user", "project"]);
        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          structured_output: { ok: true },
          total_cost_usd: 0,
          duration_ms: 1,
          usage: {},
        };
      })(),
  });

  const session = await runtime.openSession({ sessionId: "s_sources_default", config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });

  for await (const _ev of run.events) {
    // drain
  }
});

test("Claude adapter respects explicit settingSources (including empty array)", async () => {
  const runtime = new ClaudeRuntime({
    query: ({ options }) =>
      (async function* () {
        assert.deepEqual(options.settingSources, []);
        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          structured_output: { ok: true },
          total_cost_usd: 0,
          duration_ms: 1,
          usage: {},
        };
      })(),
  });

  const session = await runtime.openSession({
    sessionId: "s_sources_empty",
    config: { workspace: { cwd: process.cwd() }, provider: { settingSources: [] } },
  });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });

  for await (const _ev of run.events) {
    // drain
  }
});
