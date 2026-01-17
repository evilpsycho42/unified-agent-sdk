export function normalizeStructuredOutputSchema(
  schema: Record<string, unknown> | undefined,
): { schemaForProvider: Record<string, unknown> | undefined; unwrapStructuredOutput: (value: unknown) => unknown } {
  if (!schema) {
    return { schemaForProvider: schema, unwrapStructuredOutput: (value) => value };
  }

  // Many providers enforce structured output more reliably when the schema root is an object.
  // Wrap non-object roots (like top-level arrays) and unwrap results back to the requested shape.
  const rootType = (schema as { type?: unknown }).type;
  if (rootType === "object") {
    return { schemaForProvider: schema, unwrapStructuredOutput: (value) => value };
  }

  const wrapped: Record<string, unknown> = {
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
