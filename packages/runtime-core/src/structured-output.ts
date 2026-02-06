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

  const unwrapFallbackSingleProperty = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== 1) return value;
    const candidate = record[keys[0]];

    if (rootType === "array") return Array.isArray(candidate) ? candidate : value;
    if (rootType === "string") return typeof candidate === "string" ? candidate : value;
    if (rootType === "number") return typeof candidate === "number" ? candidate : value;
    if (rootType === "integer") return Number.isInteger(candidate) ? candidate : value;
    if (rootType === "boolean") return typeof candidate === "boolean" ? candidate : value;
    if (rootType === "null") return candidate === null ? candidate : value;

    return value;
  };

  return {
    schemaForProvider: wrapped,
    unwrapStructuredOutput: (value) => {
      if (value && typeof value === "object" && !Array.isArray(value) && "value" in value) {
        return (value as { value?: unknown }).value;
      }
      return unwrapFallbackSingleProperty(value);
    },
  };
}
