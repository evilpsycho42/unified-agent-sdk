# Configuration

This SDK splits configuration into:
- **Unified config** (portable): owned by `@unified-agent-sdk/runtime-core`
- **Provider config** (provider-specific): owned by each provider adapter package

The orchestrator should generally depend on the unified interfaces (`UnifiedAgentRuntime` / `UnifiedSession`) and only decide *which provider runtime to construct* at the composition root.

## Quick comparison (Claude vs Codex)

| Concern | Claude (`@unified-agent-sdk/provider-claude`) | Codex (`@unified-agent-sdk/provider-codex`) |
|---|---|---|
| Runtime config type | `ClaudeRuntimeConfig` | `CodexRuntimeConfig` |
| Session provider type (`SessionConfig.provider`) | `ClaudeSessionConfig` | `CodexSessionConfig` = `Omit<ThreadOptions, "workingDirectory" \| "additionalDirectories" \| "model">` |
| Run provider type (`RunConfig.provider`) | `Partial<ClaudeSessionConfig>` (merged into options) | `never` (not supported) |
| Workspace `cwd` mapping | `Options.cwd` | `ThreadOptions.workingDirectory` |
| Workspace `additionalDirs` mapping | `Options.additionalDirectories` | `ThreadOptions.additionalDirectories` |
| Claude Code settings files | `settingSources` defaults to `["user","project"]` when omitted | *(n/a)* |
| Codex git repo check | *(n/a)* | `createRuntime()` defaults `skipGitRepoCheck=true` |
| Sandbox/permissions (portable) | `SessionConfig.permissions` (mapped) | `SessionConfig.permissions` (mapped) |
| Structured output (`RunConfig.outputSchema`) | `Options.outputFormat = { type: "json_schema", schema }` | forwarded as `turnOptions.outputSchema` |
| Cancellation (`RunConfig.signal`) | mirrored into Claude `abortController` | mirrored into `turnOptions.signal` |
| Resume support | `resumeSession(handle.nativeSessionId)` | `resumeSession(handle.nativeSessionId)` |

## Unified config reference (portable)

All unified config types are defined in `packages/runtime-core/src/index.ts`.

| Type | Purpose | Key fields |
|---|---|---|
| `WorkspaceConfig` | Filesystem / workspace scope for a session | `cwd`, `additionalDirs?` |
| `SessionConfig<TProvider = ProviderConfig>` | Per-session config | `workspace?`, `model?`, `permissions?`, `provider?` |
| `RunConfig<TRunProvider = ProviderConfig>` | Per-run config | `outputSchema?`, `signal?`, `provider?` |
| `RunRequest<TRunProvider = ProviderConfig>` | Run invocation payload | `input`, `config?` |

## Unified sandbox/permission config (portable)

`SessionConfig.permissions` provides a small, provider-agnostic control surface:

| Field | Meaning |
|---|---|
| `permissions.network` | Allow outbound network + web search where supported |
| `permissions.sandbox` | Enable provider sandboxing where supported |
| `permissions.write` | Allow filesystem writes / other mutating actions |
| `permissions.yolo` | Shortcut: `network=true`, `write=true`, `sandbox=false` |

## How layers compose (what gets applied where)

| Layer | Unified field | Claude adapter behavior | Codex adapter behavior |
|---|---|---|---|
| Runtime defaults | *(provider-specific)* | `ClaudeRuntimeConfig.defaults` applied to every `query()` | `CodexRuntimeConfig.defaults` applied to every thread |
| Session permissions | `SessionConfig.permissions` | maps to Claude permission + sandbox options | maps to `ThreadOptions` (sandbox/network/approval) |
| Session provider config | `SessionConfig.provider` | merged into Claude `Options` | merged into `ThreadOptions` |
| Session workspace | `SessionConfig.workspace` | sets `cwd` + `additionalDirectories` | sets `workingDirectory` + `additionalDirectories` *(only if workspace is provided)* |
| Session model | `SessionConfig.model` | sets `Options.model` | sets `ThreadOptions.model` |
| Run provider config | `RunConfig.provider` | merged (best-effort) into `Options` | not supported (`never`) |
| Run structured output | `RunConfig.outputSchema` | sets `options.outputFormat` | sets `turnOptions.outputSchema` |
| Run cancellation | `RunConfig.signal` | mirrors into `options.abortController` | mirrors into `turnOptions.signal` |

## Unified-owned keys (avoid “double sources of truth”)

Some provider SDK options are deliberately **owned by unified config** and therefore excluded from the provider config types:

| Provider | Owned by unified config | Where to set it |
|---|---|---|
| Claude | `cwd`, `additionalDirectories`, `model`, `resume`, `abortController` | `SessionConfig.workspace`, `SessionConfig.model`, `resumeSession()`, `RunConfig.signal` |
| Codex | `workingDirectory`, `additionalDirectories`, `model` | `SessionConfig.workspace`, `SessionConfig.model` |

If you’re looking for an orchestrator-friendly constructor, see `docs/orchestrator.md` and `createRuntime()` in `@unified-agent-sdk/runtime`.

### Codex permission mapping note

The Codex adapter maps `SessionConfig.permissions` into `ThreadOptions` and uses `sandboxMode` as the primary enforcement mechanism. In particular, `permissions.sandbox=false` with `permissions.write=true` maps to `sandboxMode: "danger-full-access"` (unsafe; similar to “YOLO” behavior).
