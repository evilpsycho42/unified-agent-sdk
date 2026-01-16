# Interactive runner

This repo includes a small terminal runner that lets you chat with the SDK and watch the `RuntimeEvent` stream while tweaking provider + workspace + unified permissions.

## Run

Build + start an interactive session:

```sh
npm run interactive -- codex scripts/configs/codex.yaml .cache/ua-interactive/codex
# or
npm run interactive -- claude scripts/configs/claude.yaml .cache/ua-interactive/claude
```

Provider auth is still done via environment variables:
- Codex: `CODEX_API_KEY` (or `OPENAI_API_KEY`)
- Claude: `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`)

## Config YAML

The second argument is a YAML file that provides:
- `env`: extra env vars for the provider process
- `defaultOpts`: passed to `createRuntime({ defaultOpts })` (e.g. `workspace`, `permissions`, `model`)
- *(Claude only, optional)* `claude`: process spawning overrides (e.g. `executable`, `pathToClaudeCodeExecutable`)

`defaultOpts.permissions` supports the unified `yolo` shortcut (sets `network=true`, `write=true`, `sandbox=false`).

See:
- `scripts/configs/codex.yaml`
- `scripts/configs/claude.yaml`

## Home

The third argument is the provider home directory to use (passed as `createRuntime({ home })`), e.g. `.cache/ua-interactive/codex`.

## Commands

While running, type:

- `:status` (print `session.status()`)
- `:config` (print effective runner config)
- `:new` (dispose + open a fresh session)

Exit with Ctrl-D. While a run is active, Ctrl-C cancels it; otherwise Ctrl-C exits.

## Examples

Allow network (still no writes) by editing the YAML:

```sh
npm run interactive -- codex scripts/configs/codex.yaml .cache/ua-interactive/codex
```

Run with full autonomy (network + writes, sandbox off) by setting `defaultOpts.permissions.yolo: true`:

```sh
npm run interactive -- claude scripts/configs/claude.yaml .cache/ua-interactive/claude
```

## Troubleshooting

If Claude fails with `spawn node ENOENT`, add a `claude:` block to your YAML to point at an absolute Node (and optionally a Claude Code entrypoint). See the commented examples in `scripts/configs/claude.yaml`.
