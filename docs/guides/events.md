# Events

Every `run()` produces a unified `RuntimeEvent` stream.

## Consume streaming output

```ts
const run = await session.run({ input });

for await (const ev of run.events) {
  if (ev.type === "assistant.delta") process.stdout.write(ev.textDelta);
  if (ev.type === "tool.call") console.log("tool.call", ev.toolName);
  if (ev.type === "tool.result") console.log("tool.result", ev.callId);
  if (ev.type === "run.completed") console.log("done", ev.status);
}
```

## Event model

Common events:
- `run.started`
- `assistant.delta` / `assistant.message`
- `assistant.reasoning.delta` / `assistant.reasoning.message` (best-effort; check `capabilities().reasoningEvents`)
- `tool.call` / `tool.result` (provider-dependent)
- `run.completed`

For debugging and forward-compatibility, adapters can emit `provider.event` with raw upstream payloads.

## Streaming notes

- `run.events` is single-consumer (consume it promptly if you want complete streaming output/telemetry).
- `run.result` settles even if you never iterate `run.events`.
