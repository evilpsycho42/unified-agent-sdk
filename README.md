# Unified Agent SDK

Build an orchestrator once against a **single runtime/session interface**, then swap agent backends at the composition root.

This SDK unifies:
- **Configuration** (`workspace`, `model`, `outputSchema`, `signal`) + explicit provider config
- **Permissions** (`sandbox` / `write` / `network` / `yolo`) mapped by adapters
- **Session behavior** (`openSession()` + `run()` + a consistent `RuntimeEvent` stream)

**Supported providers (today):**
- Anthropic Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- OpenAI Codex SDK (`@openai/codex-sdk`)

**Planned:** OpenCode + other agent SDK adapters.

## 1. Target & advantages

The goal is portability: write orchestration logic once against `UnifiedAgentRuntime` / `UnifiedSession`, then choose the provider runtime when you bootstrap your app.

You get a consistent `UnifiedSession.run()` API, a common `RuntimeEvent` stream, and a small unified config surface so providers don’t leak throughout your codebase.

## 2. Basic use case

```ts
import { createRuntime, SessionBusyError } from "@unified-agent-sdk/runtime";

const runtime = createRuntime({
  provider: "@openai/codex-sdk", // or "@anthropic-ai/claude-agent-sdk"
  home: null, // inherit ~/.codex or ~/.claude (unless env overrides it)
  default_opts: { model: "gpt-5" },
});

const session = await runtime.openSession({
  sessionId: "demo",
  config: {
    workspace: { cwd: process.cwd() },
    permissions: { sandbox: true, write: false, network: false },
    provider: {},
  },
});

try {
  const run = await session.run({
    input: { parts: [{ type: "text", text: "Return JSON: {\"ok\": true}." }] },
    config: { outputSchema: { type: "object", additionalProperties: true } },
  });

  // Option A: stream events (single-consumer; optional).
  for await (const ev of run.events) {
    if (ev.type === "assistant.delta") process.stdout.write(ev.textDelta);
    if (ev.type === "run.completed") console.log("\n", ev.status, ev.structuredOutput);
  }

  // Option B: only await the final result (no need to consume events).
  // const done = await run.result;
} catch (e) {
  // Sessions are single-flight: queue/schedule in your orchestrator.
  if (e instanceof SessionBusyError) console.error("Session busy:", e.activeRunId);
  else throw e;
} finally {
  await session.dispose();
  await runtime.close();
}
```

## 3. Install

From npm (once published):

```sh
npm install @unified-agent-sdk/runtime
```

Then install at least one provider SDK (they are peer dependencies of the adapters):

```sh
# Codex
npm install @openai/codex-sdk

# Claude
npm install @anthropic-ai/claude-agent-sdk zod@^4
```

From source (this repo):

```sh
npm install
npm run build
```

## 4. Configuration & permissions

The unified surface area is intentionally small:
- **Session config** (`openSession({ config })`): `workspace`, `model`, `permissions`, `provider`
- **Run config** (`run({ config })`): `outputSchema`, `signal`, plus provider overrides where supported

Unified permissions live on `SessionConfig.permissions`:
- `network`: allow outbound network + web search where supported
- `write`: allow filesystem writes / other mutating actions
- `sandbox`: enable provider sandboxing / workspace scoping where supported
- `yolo`: shorthand for full autonomy (`network=true`, `write=true`, `sandbox=false`)

Read these next:
- [`docs/config.md`](docs/config.md) — unified vs provider config (with comparison tables)
- [`docs/permission.md`](docs/permission.md) — permission mapping details (Codex vs Claude)
- [`docs/orchestrator.md`](docs/orchestrator.md) — orchestrator wiring + `createRuntime()`
