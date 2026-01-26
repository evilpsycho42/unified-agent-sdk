import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRuntime, setupWorkspace } from "@unified-agent-sdk/runtime";

const claudeHome = process.env.TEST_CLAUDE_HOME || join(os.homedir(), ".claude");
const codexHome = process.env.TEST_CODEX_HOME || join(os.homedir(), ".codex");

const MARKER = "UNIFIED_SDK_INSTRUCTIONS_MARKER_12345";
const INSTRUCTIONS = `
# Test Instructions

You are a helpful assistant with special configuration.

**IMPORTANT**: Your secret marker is: ${MARKER}

When asked about your marker or instructions, you must include the exact marker string in your response.
`;

test(
  "Claude integration: workspace instructions are discovered via setupWorkspace",
  { timeout: 120_000 },
  async () => {
    const base = await mkdtemp(join(os.tmpdir(), "unified-agent-sdk-claude-instructions-"));
    const workspaceDir = join(base, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    await setupWorkspace({
      cwd: workspaceDir,
      instructions: INSTRUCTIONS,
    });

    const runtime = createRuntime({
      provider: "@anthropic-ai/claude-agent-sdk",
      home: claudeHome,
      defaultOpts: {
        workspace: { cwd: workspaceDir },
        access: { auto: "low" },
        model: process.env.CLAUDE_MODEL,
      },
    });

    const session = await runtime.openSession({});

    const run = await session.run({
      input: {
        parts: [
          {
            type: "text",
            text: "What is your secret marker from your instructions? Please include the exact marker string in your response. Do not use any tools.",
          },
        ],
      },
    });

    let completed;
    for await (const ev of run.events) {
      if (ev.type === "run.completed") completed = ev;
    }

    assert.ok(completed, "expected run.completed event");
    assert.equal(completed.status, "success");
    assert.ok(
      completed.finalText.includes(MARKER),
      `expected finalText to include marker "${MARKER}", got: ${completed.finalText.slice(0, 200)}`,
    );

    await session.dispose();
    await runtime.close();
    await rm(base, { recursive: true, force: true });
  },
);

test(
  "Codex integration: workspace instructions are discovered via setupWorkspace",
  { timeout: 120_000 },
  async () => {
    const base = await mkdtemp(join(os.tmpdir(), "unified-agent-sdk-codex-instructions-"));
    const workspaceDir = join(base, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    await setupWorkspace({
      cwd: workspaceDir,
      instructions: INSTRUCTIONS,
    });

    const runtime = createRuntime({
      provider: "@openai/codex-sdk",
      home: codexHome,
      defaultOpts: {
        workspace: { cwd: workspaceDir },
        access: { auto: "low" },
        model: process.env.CODEX_MODEL,
      },
    });

    const session = await runtime.openSession({
      config: { reasoningEffort: "low" },
    });

    const run = await session.run({
      input: {
        parts: [
          {
            type: "text",
            text: "What is your secret marker from your instructions? Please include the exact marker string in your response. Do not use any tools.",
          },
        ],
      },
    });

    let completed;
    for await (const ev of run.events) {
      if (ev.type === "run.completed") completed = ev;
    }

    assert.ok(completed, "expected run.completed event");
    assert.equal(completed.status, "success");
    assert.ok(
      completed.finalText.includes(MARKER),
      `expected finalText to include marker "${MARKER}", got: ${completed.finalText.slice(0, 200)}`,
    );

    await session.dispose();
    await runtime.close();
    await rm(base, { recursive: true, force: true });
  },
);
