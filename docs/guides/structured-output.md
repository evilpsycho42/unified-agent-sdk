# Structured Output

Use `RunConfig.outputSchema` to request schema-constrained output (JSON Schema).

```ts
const run = await session.run({
  input: { parts: [{ type: "text", text: "Return JSON with {\"ok\": true}." }] },
  config: {
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    },
  },
});

const done = await run.result;
console.log(done.structuredOutput);
```

Notes:
- Support is provider-dependent: check `await session.capabilities()` (`structuredOutput`).
- For portability, prefer schemas with an object root. If you pass a non-object root (e.g. `type: "array"`), adapters may wrap/unwrap it for you.
