# Sessions

The unified API has two main objects:
- `UnifiedAgentRuntime` (creates/resumes sessions)
- `UnifiedSession` (runs turns and streams `RuntimeEvent`s)

## Open a session

```ts
const session = await runtime.openSession({
  sessionId: "s1",
  config: {
    workspace: { cwd: process.cwd() },
    model: "gpt-5",
    reasoningEffort: "medium",
    access: { auto: "medium", network: true, webSearch: true },
  },
});
```

## Run a turn

```ts
const run = await session.run({
  input: { parts: [{ type: "text", text: "Say hello." }] },
});
```

- `run.events` is an `AsyncIterable<RuntimeEvent>` (streaming)
- `run.result` resolves to the final `run.completed` event

## One run at a time

A `UnifiedSession` only supports one active `run()` at a time. If you call `run()` concurrently, it throws `SessionBusyError`.

## Dispose and close

```ts
await session.dispose();
await runtime.close();
```

## Snapshot and resume

If the provider supports it (`capabilities().sessionResume === true`), you can snapshot a session handle and resume later:

```ts
const handle = await session.snapshot();
const resumed = await runtime.resumeSession(handle);
```
