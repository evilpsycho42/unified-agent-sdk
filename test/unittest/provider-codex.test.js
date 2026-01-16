import assert from "node:assert/strict";
import test from "node:test";

import { CodexRuntime } from "@unified-agent-sdk/provider-codex";
import { SessionBusyError } from "@unified-agent-sdk/runtime-core";

class FakeThread {
  constructor(makeEvents) {
    this._id = null;
    this._makeEvents = makeEvents;
  }

  get id() {
    return this._id;
  }

  async runStreamed(input, turnOptions = {}) {
    return { events: this._makeEvents(this, input, turnOptions) };
  }
}

class FakeCodex {
  constructor(makeEvents) {
    this._makeEvents = makeEvents;
  }

  startThread() {
    return new FakeThread(this._makeEvents);
  }

  resumeThread(id) {
    const thread = new FakeThread(this._makeEvents);
    thread._id = id;
    return thread;
  }
}

class CapturingCodex {
  constructor(makeEvents) {
    this.lastThreadOptions = null;
    this._makeEvents = makeEvents;
  }

  startThread(options) {
    this.lastThreadOptions = options ?? null;
    return new FakeThread(this._makeEvents);
  }
}

test("CodexSession.cancel(runId) aborts the run and reports cancelled", async () => {
  const runtime = new CodexRuntime({
    defaults: { modelReasoningEffort: "low" },
    codex: new FakeCodex(async function* (_thread, _input, turnOptions) {
      const signal = turnOptions.signal;
      yield { type: "thread.started", thread_id: "t1" };
      yield { type: "turn.started" };
      await new Promise((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", resolve, { once: true });
      });
      throw new Error("aborted");
    }),
  });

  const session = await runtime.openSession({ sessionId: "s1", config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });

  const events = [];
  for await (const ev of run.events) {
    events.push(ev);
    if (ev.type === "run.started") await session.cancel(run.runId);
  }

  const done = events.find((e) => e.type === "run.completed");
  assert.ok(done, "expected run.completed event");
  assert.equal(done.status, "cancelled");
});

test("Codex adapter resolves run.result even when events are not consumed", async () => {
  const runtime = new CodexRuntime({
    defaults: { modelReasoningEffort: "low" },
    codex: new FakeCodex(async function* (thread) {
      thread._id = "t_result_only";
      yield { type: "thread.started", thread_id: "t_result_only" };
      yield { type: "item.completed", item: { id: "m1", type: "agent_message", text: "ok" } };
      yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
    }),
  });

  const session = await runtime.openSession({ sessionId: "s_result_only", config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });

  const done = await run.result;
  assert.equal(done.type, "run.completed");
  assert.equal(done.status, "success");
  assert.equal((await session.status()).state, "idle");
});

test("CodexSession.run rejects concurrent runs (SessionBusyError)", async () => {
  const runtime = new CodexRuntime({
    defaults: { modelReasoningEffort: "low" },
    codex: new FakeCodex(async function* (thread, _input, turnOptions) {
      const signal = turnOptions.signal;
      thread._id = "t_busy";
      yield { type: "thread.started", thread_id: "t_busy" };
      yield { type: "turn.started" };
      await new Promise((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", resolve, { once: true });
      });
      throw new Error("aborted");
    }),
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

test("Codex adapter best-effort parses structured output when outputSchema is set", async () => {
  const runtime = new CodexRuntime({
    defaults: { modelReasoningEffort: "low" },
    codex: new FakeCodex(async function* (thread, _input, _turnOptions) {
      thread._id = "t2";
      yield { type: "thread.started", thread_id: "t2" };
      yield { type: "item.completed", item: { id: "m1", type: "agent_message", text: "{\"hello\":\"world\"}" } };
      yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
    }),
  });

  const session = await runtime.openSession({ sessionId: "s2", config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({
    input: { parts: [{ type: "text", text: "hello" }] },
    config: { outputSchema: { type: "object" } },
  });

  let done;
  for await (const ev of run.events) {
    if (ev.type === "run.completed") done = ev;
  }

  assert.ok(done, "expected run.completed event");
  assert.equal(done.status, "success");
  assert.equal(done.finalText, "{\"hello\":\"world\"}");
  assert.deepEqual(done.structuredOutput, { hello: "world" });
});

test("Codex adapter wraps non-object outputSchema roots and unwraps structuredOutput", async () => {
  const runtime = new CodexRuntime({
    defaults: { modelReasoningEffort: "low" },
    codex: new FakeCodex(async function* (thread, _input, turnOptions) {
      assert.equal(typeof turnOptions.outputSchema, "object");
      assert.ok(turnOptions.outputSchema && turnOptions.outputSchema.type === "object", "expected wrapped outputSchema.type=object");

      thread._id = "t2_array";
      yield { type: "thread.started", thread_id: "t2_array" };
      yield { type: "item.completed", item: { id: "m1", type: "agent_message", text: "{\"value\":[1,2,3]}" } };
      yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
    }),
  });

  const session = await runtime.openSession({ sessionId: "s2_array", config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({
    input: { parts: [{ type: "text", text: "return numbers" }] },
    config: { outputSchema: { type: "array", items: { type: "integer" } } },
  });

  let done;
  for await (const ev of run.events) {
    if (ev.type === "run.completed") done = ev;
  }

  assert.ok(done, "expected run.completed event");
  assert.equal(done.status, "success");
  assert.equal(done.finalText, "{\"value\":[1,2,3]}");
  assert.deepEqual(done.structuredOutput, [1, 2, 3]);
});

test("Codex adapter does not emit file.changed when file_change status is failed", async () => {
  const runtime = new CodexRuntime({
    defaults: { modelReasoningEffort: "low" },
    codex: new FakeCodex(async function* (thread) {
      thread._id = "t3";
      yield { type: "thread.started", thread_id: "t3" };
      yield {
        type: "item.completed",
        item: {
          id: "fc1",
          type: "file_change",
          status: "failed",
          changes: [{ path: "README.md", kind: "update" }],
        },
      };
      yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
    }),
  });

  const session = await runtime.openSession({ sessionId: "s3", config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });

  const emittedTypes = [];
  for await (const ev of run.events) emittedTypes.push(ev.type);

  assert.ok(!emittedTypes.includes("file.changed"));
});

test("Codex adapter maps unified SessionConfig.permissions into ThreadOptions (2x2x2 + yolo)", async (t) => {
  const makeEvents = async function* (thread) {
    thread._id = "t_perm";
    yield { type: "thread.started", thread_id: "t_perm" };
    yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
  };

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
      const codex = new CapturingCodex(makeEvents);
      const runtime = new CodexRuntime({ codex, defaults: { modelReasoningEffort: "low" } });

      const session = await runtime.openSession({
        sessionId: "s_perm",
        config: { workspace: { cwd: process.cwd() }, permissions: c.permissions },
      });
      const run = await session.run({ input: { parts: [{ type: "text", text: "hi" }] } });
      for await (const _ev of run.events) {
        // drain
      }

      assert.ok(codex.lastThreadOptions, "expected thread options to be captured");
      assert.equal(codex.lastThreadOptions.approvalPolicy, "never");

      if (c.permissions.yolo) {
        assert.equal(codex.lastThreadOptions.sandboxMode, "danger-full-access");
        assert.equal(codex.lastThreadOptions.networkAccessEnabled, true);
        assert.equal(codex.lastThreadOptions.webSearchEnabled, true);
        return;
      }

      const expectedNetwork = Boolean(c.permissions.network);
      const expectedWrite = Boolean(c.permissions.write);
      const expectedSandbox = Boolean(c.permissions.sandbox);

      assert.equal(
        codex.lastThreadOptions.sandboxMode,
        !expectedWrite ? "read-only" : expectedSandbox ? "workspace-write" : "danger-full-access",
      );
      assert.equal(codex.lastThreadOptions.networkAccessEnabled, expectedNetwork);
      assert.equal(codex.lastThreadOptions.webSearchEnabled, expectedNetwork);
    });
  }
});
