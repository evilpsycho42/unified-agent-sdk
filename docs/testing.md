# Testing

This repo supports three practical validation modes: **unit**, **smoke**, and **integration**. Start with typecheck.

One important behavioral note:
- `UnifiedSession.run()` starts immediately. `RunHandle.result` will settle even if you never iterate `RunHandle.events`.
- If you want streaming output / detailed telemetry, iterate `RunHandle.events` promptly; the event stream is buffered with an internal cap and may drop events if not consumed.

## At a glance

| Level | What it validates | Real execution? | Command |
|---|---|---:|---|
| 0 | Type safety across packages | No | `npm run typecheck` |
| 1 | Adapter behavior with fakes (event mapping, cancellation) | No | `npm run test:unittest` |
| 2 | Smoke tests (real SDK + real CLI) | Yes (local) | `npm run test:smoke` |
| 3 | Integration tests (real SDK + real API calls) | Yes (network/cost) | `npm run test:integration` |

## Unit tests (default)

`npm test` runs the Node test runner over `test/unittest/**/*.test.js` only.

```sh
npm test
```

## Smoke tests (real execution)

Smoke tests run the real SDKs/CLIs and make real API calls. Run them locally to verify your environment (auth, CLI, sandboxing).

### Provider peer dependencies

Provider SDKs are peer dependencies. If you don’t already have them installed, install:

```sh
npm i -w packages/provider-claude @anthropic-ai/claude-agent-sdk zod@^4
npm i -w packages/provider-codex  @openai/codex-sdk
```

```sh
npm run test:smoke
```

Smoke tests load a repo-root `.env` file automatically (if present).

## Integration tests (real API; opt-in)

Auth env vars:
- Codex: `CODEX_API_KEY` or `OPENAI_API_KEY` (optional: `CODEX_MODEL`, `CODEX_BASE_URL`).
- Claude: `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` (optional: `CLAUDE_MODEL`, `ANTHROPIC_BASE_URL`).

Then:

```sh
npm run test:integration
```

To run a single provider's integration tests, run the file directly (only that provider's credentials are required):

```sh
# Codex only
node --test test/integration/codex.integration.test.js

# Claude only
node --test test/integration/claude.integration.test.js
```

## Provider-specific notes

| Provider | Common CI defaults | Notes |
|---|---|---|
| Codex | `sandboxMode: "read-only"`, `approvalPolicy: "never"`, `webSearchEnabled: false`, `networkAccessEnabled: false`, `skipGitRepoCheck: true` | Set `CODEX_HOME` to a repo-local dir to avoid writing to user home |
| Claude | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_ERROR_REPORTING=1` | Structured output may take multiple turns (`maxTurns >= 3`) |
