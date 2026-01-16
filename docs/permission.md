# Permissions

This SDK exposes a small, provider-agnostic permission surface via `SessionConfig.permissions`:

```ts
type PermissionsConfig = {
  network?: boolean;
  sandbox?: boolean;
  write?: boolean;
  yolo?: boolean; // shorthand: network=true, write=true, sandbox=false
};
```

These flags are **mapped by each provider adapter** into that provider’s sandbox/approval/permission mechanisms.

Source of truth:
- Codex mapping: `packages/provider-codex/src/index.ts` (`mapUnifiedPermissionsToCodex`)
- Claude mapping: `packages/provider-claude/src/index.ts` (`mapUnifiedPermissionsToClaude`)

## Unified intent

- `write=false`: allow read-only inspection; deny mutations (file writes, destructive shell commands).
- `write=true`: allow operations (subject to other flags).
- `network=false`: disable web fetch/search where supported; other network use is provider-dependent.
- `sandbox=true`: use provider sandboxing and/or workspace scoping where supported.
- `yolo=true`: full autonomy (provider-dependent; potentially unsafe).

## Codex

Codex enforcement is primarily driven by `ThreadOptions.sandboxMode` + `ThreadOptions.approvalPolicy`.

### Mapping (unified → Codex)

The Codex adapter sets:
- `approvalPolicy = "never"` (no interactive approvals)
- `networkAccessEnabled = permissions.network`
- `webSearchEnabled = permissions.network`

And maps `permissions.sandbox` + `permissions.write` to `sandboxMode`:
- `sandbox=true,  write=false` → `"read-only"`
- `sandbox=true,  write=true`  → `"workspace-write"`
- `sandbox=false, write=true`  → `"danger-full-access"` (**unsafe; YOLO-like**)
- `sandbox=false, write=false` → `"read-only"` (forced)
- `yolo=true` → `"danger-full-access"`

Notes:
- Codex sandbox modes mostly constrain **writes/execution scope**; read-only inspection may still read broadly depending on Codex CLI behavior.

## Claude

Claude enforcement combines:
- Claude Code permission mode (`permissionMode`)
- tool allow/deny (adapter uses `disallowedTools`)
- programmatic permission gate (`canUseTool`) when non-interactive
- optional Claude sandbox settings (`Options.sandbox`, injected via CLI `--settings`)

### Conceptual `sandboxMode` mapping (for parity with Codex)

Claude does not have a Codex-style `sandboxMode` flag, but the unified adapter behavior is designed to match the same *intent*:

- `sandbox=true,  write=false` → `"read-only"`
- `sandbox=true,  write=true`  → `"workspace-write"`
- `sandbox=false, write=true`  → `"danger-full-access"` (**unsafe; YOLO-like**)
- `sandbox=false, write=false` → `"read-only"` (forced)
- `yolo=true` → `"danger-full-access"`

This is implemented via Claude Code permission mode + tool gating (not a single provider flag).

### Mapping (unified → Claude)

If `yolo=true`, the adapter uses:
- `permissionMode="bypassPermissions"`
- `allowDangerouslySkipPermissions=true`
- `sandbox.enabled=false`
- no `canUseTool` callback

Otherwise (`yolo=false`), the adapter uses:
- `permissionMode="default"`
- `permissionPromptToolName=undefined` (no interactive prompt tool)
- `sandbox.enabled = permissions.sandbox`
- `sandbox.autoAllowBashIfSandboxed = false` (so Bash decisions still flow through the permission gate)
- `disallowedTools` always includes `AskUserQuestion`
  - plus `WebFetch`/`WebSearch` when `network=false`
  - plus `Write`/`Edit`/`NotebookEdit`/`KillShell` when `write=false`
- `canUseTool` enforces:
  - `write=false`: deny mutating tools; allow **read-only** `Bash` commands (conservative allowlist, blocks network commands when `network=false`)
  - `sandbox=true` and `write=true`: restrict **writes** to the session workspace roots (`workspace.cwd` + `workspace.additionalDirs`) while allowing reads outside

Notes:
- Claude’s “sandbox” does not behave exactly like Codex’s sandbox modes; workspace scoping is implemented via permission gating and provider behavior.
- In the Claude adapter, `network=false` removes `WebFetch`/`WebSearch` and only gates network-ish `Bash` commands when `write=false`. If `write=true`, network-capable `Bash` commands are not explicitly blocked by the unified adapter (settings files may still restrict them).
