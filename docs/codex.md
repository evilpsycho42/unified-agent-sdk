# Codex provider notes

This repo’s Codex adapter (`@unified-agent-sdk/provider-codex`) wraps `@openai/codex-sdk` and maps it into the unified `UnifiedSession.run()` + `RuntimeEvent` stream.

## At a glance

| Concern | Where to configure it |
|---|---|
| Runtime defaults (sandbox, approvals, web search, etc.) | `new CodexRuntime({ defaults: ThreadOptions })` |
| Client connection/auth (`apiKey`, `baseUrl`) | `new CodexRuntime({ client: CodexOptions })` |
| Session model | `openSession({ config: { model } })` |
| Per-session options (minus unified-owned keys: `workingDirectory`, `additionalDirectories`, `model`) | `openSession({ config: { provider: CodexSessionConfig } })` |
| Workspace scope | `openSession({ config: { workspace } })` |
| Unified sandbox/permissions | `openSession({ config: { permissions } })` |
| Per-run structured output + cancellation | `run({ config: { outputSchema, signal } })` |
| Run-level provider config | **Not supported** (`RunConfig.provider` is typed as `never`) |

## Configuration in this SDK

### Runtime

```ts
import { CodexRuntime } from "@unified-agent-sdk/provider-codex";

const runtime = new CodexRuntime({
  client: { apiKey: process.env.OPENAI_API_KEY, baseUrl: process.env.CODEX_BASE_URL },
  defaults: {
    // You can set provider defaults here, but prefer `SessionConfig.permissions`
    // for orchestrator-friendly, portable sandbox/permission controls.
    sandboxMode: "read-only",
    approvalPolicy: "never",
    webSearchEnabled: false,
    networkAccessEnabled: false,
  },
});
```

### Session

In the unified SDK, workspace maps to Codex thread options:

| Unified | Codex |
|---|---|
| `workspace.cwd` | `ThreadOptions.workingDirectory` |
| `workspace.additionalDirs` | `ThreadOptions.additionalDirectories` |

```ts
const session = await runtime.openSession({
  sessionId: "s1",
  config: {
    workspace: { cwd: process.cwd(), additionalDirs: ["/tmp"] },
    model: process.env.CODEX_MODEL,
    permissions: {
      sandbox: true,
      write: false,
      network: false,
    },
    provider: {
      // `CodexSessionConfig` is `ThreadOptions` minus unified-owned keys.
      // Use this for other Codex knobs; `permissions` is the preferred place
      // for sandbox/network/write behavior.
    },
  },
});
```

### Run

```ts
const run = await session.run({
  input: { parts: [{ type: "text", text: "Say hello." }] },
  config: { outputSchema: { type: "object" } },
});
```

#### Non-object root schemas

For portability, prefer schemas with an object root. If you pass a non-object root schema (for example `type: "array"`), this SDK will transparently wrap it under `{ "value": ... }` for Codex and then unwrap `run.completed.structuredOutput` back to your requested shape.

## Sandbox + approvals (how Codex controls access)

`@openai/codex-sdk` spawns the bundled `codex` CLI. Sandbox + approval behavior is enforced by the CLI (config files + flags) and exposed to the SDK via `ThreadOptions`.

Key knobs you can set in `ThreadOptions` / `CodexSessionConfig`:

### Sandbox (`sandboxMode`)

Controls the policy for model-generated shell commands:
- `"read-only"`: “browse mode” (safe by default; edits/commands require approval).
- `"workspace-write"`: allows edits + command execution in the working directory and any `additionalDirectories`.
- `"danger-full-access"`: removes sandbox restrictions (use with extreme caution).

#### How unified `permissions` map to `sandboxMode`

When using `@unified-agent-sdk/runtime` / `SessionConfig.permissions`, the Codex adapter maps:
- `sandbox=true, write=false` → `sandboxMode: "read-only"`
- `sandbox=true, write=true` → `sandboxMode: "workspace-write"`
- `sandbox=false, write=true` → `sandboxMode: "danger-full-access"` (**unsafe; effectively YOLO-like**)
- `sandbox=false, write=false` → `sandboxMode: "read-only"` (forced; “no sandbox but no writes” isn’t safely representable)

Note: some Codex builds treat `"danger-full-access"` as broadly permissive regardless of other toggles (including network).

### Approvals (`approvalPolicy`)

Controls when Codex pauses for approval before executing a command:
- `"on-request"`: the model requests approval when it thinks it needs it (default behavior).
- `"untrusted"`: only auto-runs known-safe read-only commands; prompts for other commands.
- `"on-failure"`: auto-runs in the sandbox; prompts only on failure (for escalation).
- `"never"`: never prompts (any operation that would have asked will be denied/blocked).

### Network vs web search

Codex separates “local network” from “web search”:
- `networkAccessEnabled` toggles network access for commands in the `workspace-write` sandbox (`sandbox_workspace_write.network_access`).
- `webSearchEnabled` toggles Codex’s `web_search` tool (`features.web_search_request` / `--search`), which is separate from local network access.

### Mapping (SDK → Codex CLI/config)

| Codex SDK (`ThreadOptions`) | Codex CLI flag / config key |
|---|---|
| `sandboxMode` | `--sandbox` / `sandbox_mode` |
| `approvalPolicy` | `--ask-for-approval` / `approval_policy` |
| `workingDirectory` | `--cd` |
| `additionalDirectories` | `--add-dir` / `sandbox_workspace_write.writable_roots` |
| `networkAccessEnabled` | `sandbox_workspace_write.network_access` |
| `webSearchEnabled` | `--search` / `features.web_search_request` |

### Global config (still applies)

Codex also reads global configuration (for example `~/.codex/config.toml`), and deployments can enforce repo-level constraints via `requirements.toml` (for example “always read-only” or “never bypass approvals”). If you need settings beyond what `ThreadOptions` exposes, set them in Codex’s config files.

## Practical tips

- Prefer setting `CODEX_HOME` to a repo-local directory (e.g. `.cache/codex`) to avoid writing to the user home directory.
- For predictable CI runs: `sandboxMode: "read-only"`, `approvalPolicy: "never"`, `webSearchEnabled: false`, `networkAccessEnabled: false`, `skipGitRepoCheck: true`.
