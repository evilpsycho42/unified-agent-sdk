# Instruction File Discovery (Codex vs Claude)

This spec records what `uagent <provider> exec` observed about how **project instruction files** get discovered and merged for:
- Codex (`AGENTS.md` / `AGENTS.override.md`)
- Claude (`CLAUDE.md` / `CLAUDE.local.md`)

The goal is to make behavior differences explicit so repo layouts behave predictably across providers.

## Test method (marker-based)

Because neither provider exposes a “list loaded instruction files” API, we used a simple marker approach:

1) Create a temporary workspace with instruction files in parent dirs, git root, nested subdirs, and sibling dirs.
2) Put a unique marker string in each instruction file.
3) Run `uagent ... exec` and ask the model to print which markers it can see in its loaded instructions.

Example workspace (markers in parentheses):

```text
/tmp/uagent-instructions-test
└── parent
    ├── CLAUDE.md                 (PARENT_CLAUDE_MARKER)
    ├── AGENTS.md                 (PARENT_AGENTS_MARKER)
    └── repo   [git root]
        ├── AGENTS.override.md    (PROJECT_ROOT_OVERRIDE_MARKER)
        ├── AGENTS.md             (PROJECT_ROOT_AGENTS_MARKER)
        ├── CLAUDE.md             (PROJECT_ROOT_CLAUDE_MARKER)
        ├── CLAUDE.local.md       (PROJECT_ROOT_CLAUDE_LOCAL_MARKER)
        ├── sub
        │   ├── AGENTS.md         (PROJECT_SUB_AGENTS_MARKER)
        │   ├── CLAUDE.md         (PROJECT_SUB_CLAUDE_MARKER)
        │   └── deeper            (workspace cwd)
        │       ├── AGENTS.override.md (PROJECT_DEEP_OVERRIDE_MARKER)
        │       └── CLAUDE.md          (PROJECT_DEEP_CLAUDE_MARKER)
        └── other
            ├── AGENTS.md         (PROJECT_OTHER_AGENTS_MARKER)
            └── CLAUDE.md         (PROJECT_OTHER_CLAUDE_MARKER)
```

We also added “home” instruction files:
- Codex: `CODEX_HOME/AGENTS.override.md` and `CODEX_HOME/AGENTS.md`
- Claude: `CLAUDE_CONFIG_DIR/CLAUDE.md`

## Codex: `AGENTS.md` discovery

Observed behavior via `uagent codex exec`:

1) Loads exactly one “global” file from `CODEX_HOME`:
   - prefers `AGENTS.override.md` over `AGENTS.md`.
2) Finds the git root for the workspace and walks **git root → workspace cwd**.
3) In each directory on that path, loads at most one instruction file:
   - prefers `AGENTS.override.md` over `AGENTS.md`.
4) Does **not** load `AGENTS*` from directories above git root.
5) Does **not** load `AGENTS*` from sibling directories not on the root→cwd path.

Concrete results (marker prompt):
- With `cwd = repo/sub/deeper`, Codex reported:
  - `CODEX_HOME_OVERRIDE_MARKER`
  - `PROJECT_ROOT_OVERRIDE_MARKER`
  - `PROJECT_SUB_AGENTS_MARKER`
  - `PROJECT_DEEP_OVERRIDE_MARKER`
- With `cwd = repo` (git root), Codex reported:
  - `CODEX_HOME_OVERRIDE_MARKER`
  - `PROJECT_ROOT_OVERRIDE_MARKER`

Not reported in either run:
- `CODEX_HOME_AGENTS_MARKER` (overridden by `CODEX_HOME/AGENTS.override.md`)
- `PROJECT_ROOT_AGENTS_MARKER` (overridden by `repo/AGENTS.override.md`)
- `PARENT_AGENTS_MARKER` (above git root)
- `PROJECT_OTHER_AGENTS_MARKER` (sibling dir)

## Claude: `CLAUDE.md` discovery

Observed behavior via `uagent claude exec` (Claude Code via `@anthropic-ai/claude-agent-sdk`):

1) Loads a “global” `CLAUDE.md` from `CLAUDE_CONFIG_DIR` (the `uagent --home` directory).
2) Loads `CLAUDE.md` files from the **workspace cwd** and its **parent directories**.
   - In our test, this included a `CLAUDE.md` located *above* the git root (`parent/CLAUDE.md`).
3) Did **not** load `CLAUDE.local.md` in this test.
4) Did **not** load `CLAUDE.md` from sibling directories not on the ancestor chain.

Concrete results (marker prompt) with `cwd = repo/sub/deeper`:
- Claude reported:
  - `CLAUDE_HOME_MARKER`
  - `PARENT_CLAUDE_MARKER`
  - `PROJECT_ROOT_CLAUDE_MARKER`
  - `PROJECT_SUB_CLAUDE_MARKER`
  - `PROJECT_DEEP_CLAUDE_MARKER`
- Not reported:
  - `PROJECT_ROOT_CLAUDE_LOCAL_MARKER`
  - `PROJECT_OTHER_CLAUDE_MARKER`

## Notes / gotchas

- Claude runs are sensitive to Claude Code onboarding/auth state in `CLAUDE_CONFIG_DIR`; if it is not initialized you may see `Invalid API key · Please run /login`.
- For end-to-end validation patterns (temporary workspaces, access flags), see `docs/specs/testing.md` (“Manual access testing with `uagent exec`”).
