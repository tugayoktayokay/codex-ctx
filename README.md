# codex-ctx

Event-backed memory, context health, and large-output control for OpenAI Codex.

`codex-ctx` is a zero-dependency local helper for Codex sessions. It records structured hook/tool events, writes rich project snapshots, recalls prior work, guards noisy commands, caches oversized output, and exposes the same capabilities through an MCP server.

It is designed for one practical problem: Codex history is useful, but it is not a full Claude Code-style transcript. `codex-ctx` fills that gap by building its own Codex-native event ledger from hooks.

## Highlights

- Reads recent Codex prompt history from `~/.codex/history.jsonl`.
- Records structured hook/tool events per project.
- Writes rich memory snapshots with decisions, commands, guarded actions, cache refs, prompts, and recent events.
- Searches snapshots with weighted recall: keyword coverage, title/signal boosts, and recency.
- Injects relevant project memory on prompt submit.
- Restores the latest snapshot on session start.
- Blocks or warns on commands likely to flood context or perform destructive actions.
- Caches large command/file output and provides page-by-ref retrieval.
- Provides status, reports, timelines, metrics, bloat/heavy-output audits, pruning, backups, and notes.
- Runs without external runtime dependencies beyond Node.js.

## Why This Exists

Long agent sessions produce valuable context:

- decisions made earlier
- bugs already diagnosed
- commands already run
- large outputs that should not be pasted back into the prompt
- project-specific next steps

Codex exposes enough local state and hook events to preserve that context, but it needs a small memory layer around it. `codex-ctx` is that layer.

## Architecture

```text
Codex hooks
  -> cctx hook <event>
  -> structured event ledger
  -> rich snapshots
  -> weighted recall / MCP tools / CLI reports
```

Main storage locations:

```text
~/.codex/history.jsonl
~/.codex/hooks.json
~/.codex/memories/codex-ctx/
```

Per-project data:

```text
~/.codex/memories/codex-ctx/projects/<encoded-cwd>/
  events/events.jsonl
  memory/*.md
  memory/MEMORY.md
```

Large-output cache:

```text
~/.codex/memories/codex-ctx/mcp-cache/
```

## Installation

Clone the repo:

```bash
git clone https://github.com/tugayoktayokay/codex-ctx.git
cd codex-ctx
```

Check the CLI:

```bash
./bin/cctx version
./bin/cctx status
```

Install the Codex plugin and hooks:

```bash
./bin/cctx install-all
./bin/cctx doctor
```

Expected doctor output:

```text
codex_hooks: enabled
cctx hooks: installed
marketplace: installed
plugin: enabled
```

The installer updates:

```text
~/.codex/config.toml
~/.codex/hooks.json
```

Backups are written before changing existing config files.

## Quick Start

Create a memory snapshot:

```bash
./bin/cctx snapshot --name checkpoint
```

Ask prior project memory:

```bash
./bin/cctx ask "what did we decide about auth?"
```

Inspect recent structured events:

```bash
./bin/cctx events 20
```

Get a project report:

```bash
./bin/cctx report
```

Check live context health:

```bash
./bin/cctx statusline
./bin/cctx watch --interval 5
```

## CLI Commands

```bash
./bin/cctx status
./bin/cctx history 20
./bin/cctx snapshot --name checkpoint
./bin/cctx ask "previous context"
./bin/cctx report
./bin/cctx analyze
./bin/cctx timeline 20
./bin/cctx events 20
./bin/cctx metrics --json
./bin/cctx savings
./bin/cctx value --json
./bin/cctx stats
./bin/cctx usage
./bin/cctx heavy 10
./bin/cctx bloat
./bin/cctx statusline
./bin/cctx watch --interval 5
./bin/cctx compact --name before-refactor
./bin/cctx diff
./bin/cctx file ./large.log
./bin/cctx notes add "remember this decision"
./bin/cctx backup
./bin/cctx backup list
./bin/cctx prune --days 30
./bin/cctx prune --days 30 --yes
./bin/cctx purge --yes
./bin/cctx doctor
./bin/cctx install-hooks
./bin/cctx install-plugin
./bin/cctx install-all
./bin/cctx setup
./bin/cctx plugin-fix
./bin/cctx serve
```

## MCP Tools

`cctx serve` exposes these tools:

- `codex_ctx_status`
- `codex_ctx_snapshot`
- `codex_ctx_ask`
- `codex_ctx_history`
- `codex_ctx_shell`
- `codex_ctx_read`
- `codex_ctx_cache_get`
- `codex_ctx_report`
- `codex_ctx_timeline`
- `codex_ctx_events`
- `codex_ctx_metrics`
- `codex_ctx_savings`
- `codex_ctx_heavy`
- `codex_ctx_bloat`
- `codex_ctx_statusline`
- `codex_ctx_diff`
- `codex_ctx_prune`

Use the cache-backed wrappers for commands or files that may return more than a few kilobytes:

```text
codex_ctx_shell({ "command": "npm test", "cwd": "/path/to/project" })
codex_ctx_read({ "path": "/path/to/large.log" })
codex_ctx_cache_get({ "ref": "<cache-ref>", "offset": 0, "limit": 5000 })
```

## Hooks

The installer enables Codex hooks and writes `~/.codex/hooks.json`.

Installed hook events:

- `SessionStart`: restore latest project memory.
- `UserPromptSubmit`: search snapshots and inject relevant memory.
- `PreToolUse`: block noisy or destructive commands.
- `PermissionRequest`: deny escalation for destructive command patterns.
- `PostToolUse`: record tool events, cache large output, snapshot on git commit.
- `Stop`: optionally snapshot based on context level.

Example protected command classes:

- unbounded `grep -r`
- unbounded `find`
- `ls -R`
- unbounded `tree`
- unbounded logs
- destructive `rm -rf /`, `git reset --hard`, `git clean -fd`, force push

## Event-Backed Snapshots

Snapshots are more than prompt dumps. They include:

- recent prompts
- decisions and signals
- files mentioned or touched
- commands
- blocked or guarded actions
- cache references
- recent structured events
- raw prompt text

This makes later recall much more useful than simple keyword search over chat history.

## Measuring Value

Use `cctx savings` to estimate how many tokens were avoided by large-output caching after subtracting memory recall overhead:

```bash
./bin/cctx savings
./bin/cctx savings --json
```

The estimate is based on hook logs and the configured `chars_per_token` value. It reports:

- cached output count and bytes
- gross tokens avoided
- replacement summary tokens
- memory recall overhead
- net saved tokens
- guarded command count
- largest cached outputs

## Configuration

Default config lives in:

```text
config.default.json
```

User config is copied to:

```text
~/.codex/memories/codex-ctx/config.json
```

Override the app home:

```bash
CCTX_HOME=/some/path ./bin/cctx status
```

Important config areas:

- `limits`: token estimate thresholds
- `snapshot`: memory directory and history limits
- `retrieval`: recall score thresholds
- `events`: event ledger controls
- `cache`: inline limit and TTL/size garbage collection
- `hooks`: hook rules and behavior
- `stopwords`: token filters for search/reporting

The defaults are intentionally conservative:

- auto-recall requires a stronger match before injecting memory
- large-output summaries are short enough to preserve context
- hook logs rotate automatically when they grow large

## Safety Model

`codex-ctx` is local-first:

- no hosted service
- no LLM calls
- no telemetry
- no runtime dependencies
- no secrets required

It writes local memory under `~/.codex/memories/codex-ctx`.

Before making this repository public, avoid committing your generated memory/cache directories. They are not part of the repo and are intentionally stored under `~/.codex`.

## Public Repository Notes

The committed `hooks/hooks.json` is portable. It uses a `__CCTX_BIN__` placeholder, which `cctx install-hooks` replaces with the actual local path to `bin/cctx`.

Do not copy `hooks/hooks.json` manually into `~/.codex/hooks.json`; use:

```bash
./bin/cctx install-hooks
```

## Limitations

Codex does not currently expose all Claude Code runtime surfaces:

- no plugin-defined slash commands such as `/doctor`
- no direct `PreCompact` hook
- less transcript detail than Claude Code JSONL

`codex-ctx` adapts around this by using:

- Codex prompt history
- Codex hooks
- structured event ledger
- rich snapshots
- MCP tools

Use `cctx doctor` instead of `/doctor`.

## Development

Run tests:

```bash
npm test
```

There are no npm runtime dependencies. Tests use Node's built-in test runner.

## License

MIT
