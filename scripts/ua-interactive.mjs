#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { inspect } from "node:util";

import { loadInteractiveConfig } from "./lib/interactive-config.mjs";

const PROVIDERS = {
  codex: "@openai/codex-sdk",
  claude: "@anthropic-ai/claude-agent-sdk",
};

function printUsage() {
  console.log(
    [
      "Unified Agent SDK interactive runner",
      "",
      "Usage:",
      "  npm run interactive -- <provider> <config.yaml> <home> [options]",
      "",
      "Examples:",
      "  npm run interactive -- codex scripts/configs/codex.yaml .cache/ua-interactive/codex",
      "  npm run interactive -- claude scripts/configs/claude.yaml .cache/ua-interactive/claude",
      "",
      "Options:",
      "  --show-provider-events           Print provider.event payloads.",
      "  --show-raw                        Include raw event payloads in logs (noisy).",
      "  --no-tools                        Hide tool.call/tool.result logs.",
      "  --no-files                        Hide file.changed logs.",
      "  -h, --help                        Show this help.",
      "",
      "Interactive commands:",
      "  :new  :status  :config",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = {
    help: false,
    provider: undefined,
    configPath: undefined,
    home: undefined,
    showProviderEvents: false,
    showRaw: false,
    showTools: true,
    showFiles: true,
  };

  const take = (i, flag) => {
    const v = argv[i + 1];
    if (!v || v.startsWith("-")) throw new Error(`Missing value for ${flag}`);
    return v;
  };

  const setPositional = (value) => {
    if (args.provider === undefined) args.provider = value;
    else if (args.configPath === undefined) args.configPath = value;
    else if (args.home === undefined) args.home = value;
    else throw new Error(`Unexpected extra argument: ${value}`);
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      args.help = true;
      continue;
    }
    if (!a.startsWith("--")) {
      setPositional(a);
      continue;
    }

    const [rawKey, rawValue] = a.slice(2).split("=", 2);
    const key = rawKey.startsWith("no-") ? rawKey.slice(3) : rawKey;
    const negated = rawKey.startsWith("no-");
    const value = rawValue ?? undefined;

    if (key === "show-provider-events") {
      args.showProviderEvents = !negated;
      continue;
    }
    if (key === "show-raw") {
      args.showRaw = !negated;
      continue;
    }
    if (key === "tools") {
      args.showTools = !negated;
      continue;
    }
    if (key === "files") {
      args.showFiles = !negated;
      continue;
    }

    // Legacy flags (keep for convenience):
    if (key === "provider") {
      args.provider = value ?? take(i++, "--provider");
      continue;
    }
    if (key === "config") {
      args.configPath = value ?? take(i++, "--config");
      continue;
    }
    if (key === "home") {
      args.home = value ?? take(i++, "--home");
      continue;
    }

    throw new Error(`Unknown option: --${rawKey}`);
  }

  return args;
}

function normalizeProvider(input) {
  if (!input) throw new Error("Missing <provider> (codex|claude).");
  if (input === "codex" || input === PROVIDERS.codex) return { key: "codex", id: PROVIDERS.codex };
  if (input === "claude" || input === PROVIDERS.claude) return { key: "claude", id: PROVIDERS.claude };
  throw new Error(`Unsupported provider: ${input}`);
}

function printHeader({ providerId, configPath, home, workspaceCwd }) {
  console.log("");
  console.log(`provider: ${providerId}`);
  console.log(`config: ${configPath}`);
  console.log(`home: ${home}`);
  if (workspaceCwd) console.log(`workspace.cwd: ${workspaceCwd}`);
  console.log("commands: :new, :status, :config (Ctrl-D to exit)");
  console.log("");
}

function printObject(obj) {
  console.log(inspect(obj, { depth: 8, colors: true }));
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    console.error("");
    printUsage();
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    printUsage();
    return;
  }

  const provider = normalizeProvider(args.provider);
  if (!args.configPath) throw new Error("Missing <config.yaml>.");
  if (!args.home) throw new Error("Missing <home>.");

  const home = resolve(args.home);
  const loaded = await loadInteractiveConfig({ configPath: args.configPath, providerKey: provider.key });
  const configPath = loaded.configPath;
  const env = loaded.env;
  const defaultOpts = loaded.defaultOpts;
  const claude = loaded.claude;

  const { createRuntime } = await import("@unified-agent-sdk/runtime");
  const runtime = createRuntime({
    provider: provider.id,
    home,
    env,
    ...(provider.key === "claude" && claude ? { claude } : {}),
    defaultOpts,
  });

  const openNewSession = async () => {
    const sessionId = `interactive-${randomUUID()}`;
    return runtime.openSession({ sessionId, config: { provider: {} } });
  };

  let session = await openNewSession();

  printHeader({ providerId: provider.id, configPath, home, workspaceCwd: defaultOpts?.workspace?.cwd });
  console.log(`sessionId: ${session.sessionId}`);
  if (session.nativeSessionId) console.log(`nativeSessionId: ${session.nativeSessionId}`);
  console.log("");

  const runnerConfig = () => ({
    provider: provider.id,
    configPath,
    home,
    env,
    defaultOpts,
    claude: provider.key === "claude" ? claude : undefined,
    session: { sessionId: session.sessionId, nativeSessionId: session.nativeSessionId },
  });

  let activeRun = null;
  let activeRunHadDelta = false;

  const cancelActiveRun = async () => {
    if (!activeRun) return false;
    try {
      await activeRun.cancel();
    } catch {}
    return true;
  };

  process.on("SIGINT", async () => {
    const cancelled = await cancelActiveRun();
    if (!cancelled) process.exit(0);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl.setPrompt("ua> ");
  rl.prompt();

  const reopenSession = async () => {
    await session.dispose();
    session = await openNewSession();
    console.log(`(new session) sessionId=${session.sessionId}${session.nativeSessionId ? ` nativeSessionId=${session.nativeSessionId}` : ""}`);
  };

  const onEvent = (ev) => {
    if (ev.type === "assistant.delta") {
      activeRunHadDelta = true;
      process.stdout.write(ev.textDelta);
      return;
    }
    if (ev.type === "assistant.message") {
      if (!activeRunHadDelta && ev.message?.text) {
        process.stdout.write(ev.message.text);
        if (!ev.message.text.endsWith("\n")) process.stdout.write("\n");
      }
      if (ev.message?.structuredOutput !== undefined) {
        console.log("\n[structured]");
        printObject(ev.message.structuredOutput);
      }
      return;
    }
    if (ev.type === "tool.call" && args.showTools) {
      console.error(`\n[tool.call] ${ev.toolName}`);
      if (args.showRaw) console.error(inspect(ev, { depth: 6, colors: true }));
      return;
    }
    if (ev.type === "tool.result" && args.showTools) {
      console.error(`\n[tool.result] ${ev.callId}`);
      if (args.showRaw) console.error(inspect(ev, { depth: 6, colors: true }));
      return;
    }
    if (ev.type === "file.changed" && args.showFiles) {
      console.error(`\n[file.${ev.change.kind}] ${ev.change.path}`);
      return;
    }
    if (ev.type === "provider.event" && args.showProviderEvents) {
      console.error(`\n[provider.event] ${ev.provider}`);
      console.error(inspect(ev, { depth: 6, colors: true }));
      return;
    }
    if (ev.type === "error") {
      console.error(`\n[error] ${ev.message}`);
      return;
    }
    if (ev.type === "run.completed") {
      if (activeRunHadDelta) process.stdout.write("\n");
      console.log(`[completed] ${ev.status}`);
      if (ev.structuredOutput !== undefined) {
        console.log("\n[structured]");
        printObject(ev.structuredOutput);
      }
      if (args.showRaw) {
        console.log("\n[run.completed raw]");
        printObject(ev);
      }
    }
  };

  const runTurn = async (text) => {
    activeRunHadDelta = false;
    const run = await session.run({
      input: { parts: [{ type: "text", text }] },
    });
    activeRun = run;
    try {
      for await (const ev of run.events) onEvent(ev);
    } finally {
      activeRun = null;
    }
  };

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) return rl.prompt();

    try {
      if (activeRun) {
        console.log("(run active; use Ctrl-C)");
      } else if (input === ":status") {
        printObject(await session.status());
      } else if (input === ":config") {
        printObject(runnerConfig());
      } else if (input === ":new") {
        await reopenSession();
      } else if (input.startsWith(":")) {
        console.log("Unknown command. Supported: :new, :status, :config");
      } else {
        await runTurn(input);
      }
    } catch (e) {
      console.error(String(e instanceof Error ? e.stack ?? e.message : e));
    } finally {
      rl.prompt();
    }
  });

  rl.on("close", async () => {
    await cancelActiveRun();
    try {
      await session.dispose();
      await runtime.close();
    } catch {}
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.stack ?? e.message : e));
  process.exit(1);
});
