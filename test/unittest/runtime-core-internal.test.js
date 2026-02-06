import assert from "node:assert/strict";
import test from "node:test";

import { AsyncEventStream, normalizeStructuredOutputSchema } from "@unified-agent-sdk/runtime-core/internal";

test("normalizeStructuredOutputSchema passthrough when schema is undefined", () => {
  const { schemaForProvider, unwrapStructuredOutput } = normalizeStructuredOutputSchema(undefined);
  assert.equal(schemaForProvider, undefined);
  assert.equal(unwrapStructuredOutput(123), 123);
});

test("normalizeStructuredOutputSchema passes object root through unchanged", () => {
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
  const { schemaForProvider, unwrapStructuredOutput } = normalizeStructuredOutputSchema(schema);
  assert.equal(schemaForProvider, schema);
  assert.deepEqual(unwrapStructuredOutput({ ok: true }), { ok: true });
});

test("normalizeStructuredOutputSchema wraps non-object roots and unwraps {value}", () => {
  const schema = { type: "array", items: { type: "integer" } };
  const { schemaForProvider, unwrapStructuredOutput } = normalizeStructuredOutputSchema(schema);
  assert.equal(schemaForProvider.type, "object");
  assert.deepEqual(unwrapStructuredOutput({ value: [1, 2, 3] }), [1, 2, 3]);
});

test("normalizeStructuredOutputSchema unwraps single-property object wrappers for non-object roots", () => {
  const arraySchema = { type: "array", items: { type: "integer" } };
  const { unwrapStructuredOutput: unwrapArray } = normalizeStructuredOutputSchema(arraySchema);
  assert.deepEqual(unwrapArray({ students: [1, 2, 3] }), [1, 2, 3]);

  const stringSchema = { type: "string" };
  const { unwrapStructuredOutput: unwrapString } = normalizeStructuredOutputSchema(stringSchema);
  assert.equal(unwrapString({ result: "ok" }), "ok");

  const numberSchema = { type: "number" };
  const { unwrapStructuredOutput: unwrapNumber } = normalizeStructuredOutputSchema(numberSchema);
  assert.equal(unwrapNumber({ score: 42.5 }), 42.5);

  const integerSchema = { type: "integer" };
  const { unwrapStructuredOutput: unwrapInteger } = normalizeStructuredOutputSchema(integerSchema);
  assert.equal(unwrapInteger({ count: 7 }), 7);

  const boolSchema = { type: "boolean" };
  const { unwrapStructuredOutput: unwrapBoolean } = normalizeStructuredOutputSchema(boolSchema);
  assert.equal(unwrapBoolean({ ok: true }), true);

  const nullSchema = { type: "null" };
  const { unwrapStructuredOutput: unwrapNull } = normalizeStructuredOutputSchema(nullSchema);
  assert.equal(unwrapNull({ value: null }), null);

  assert.deepEqual(unwrapArray({ students: [1], extra: true }), { students: [1], extra: true });
  assert.deepEqual(unwrapString({ result: 123 }), { result: 123 });
});

test("AsyncEventStream enforces single-consumer", async () => {
  const s = new AsyncEventStream();
  s[Symbol.asyncIterator]();
  assert.throws(() => s[Symbol.asyncIterator](), /only be consumed once/i);
});

test("AsyncEventStream drops oldest items when buffer is full", async () => {
  const s = new AsyncEventStream({ maxBuffer: 2 });
  s.push(1);
  s.push(2);
  s.push(3); // drops 1

  const got = [];
  for await (const v of s) {
    got.push(v);
    if (got.length === 2) break;
  }
  assert.deepEqual(got, [2, 3]);
});

test("AsyncEventStream close() ends iteration", async () => {
  const s = new AsyncEventStream();
  s.close();
  const got = [];
  for await (const v of s) got.push(v);
  assert.deepEqual(got, []);
});
