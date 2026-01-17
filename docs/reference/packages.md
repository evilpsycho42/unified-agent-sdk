# Packages

## `@unified-agent-sdk/runtime-core`

Dependency-free TypeScript interfaces and event model:
- `UnifiedAgentRuntime`, `UnifiedSession`, `RunHandle`
- `RuntimeEvent`
- unified config types (`SessionConfig`, `RunConfig`, `WorkspaceConfig`, `AccessConfig`, ...)

## `@unified-agent-sdk/runtime`

Convenience package for orchestrators:
- exports `createRuntime()`
- re-exports everything from `@unified-agent-sdk/runtime-core`
- re-exports the built-in providers (Codex + Claude)

## `@unified-agent-sdk/provider-codex`

Provider adapter for `@openai/codex-sdk`:
- maps Codex thread events into `RuntimeEvent`
- maps unified access into Codex sandbox/approval options

See: **Providers → Codex**

## `@unified-agent-sdk/provider-claude`

Provider adapter for `@anthropic-ai/claude-agent-sdk`:
- maps Claude Agent SDK / Claude Code stream into `RuntimeEvent`
- maps unified access into Claude permission/sandbox behavior

See: **Providers → Claude**

## `@unified-agent-sdk/uagent`

Small CLI for manual testing:
- interactive TUI
- `exec` runner for one-shot commands

See: **Guides → Interactive Runner** and **Specs → Testing**
