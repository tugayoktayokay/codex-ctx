# codex-ctx

Codex-specific context and memory helper.

This project is intentionally separate from `../claude-code-ctx`; it does not modify Claude Code hooks, Claude plugin files, or `~/.claude`.

## What works now

- Reads local Codex prompt history from `~/.codex/history.jsonl`.
- Estimates recent prompt context size.
- Writes project snapshots to `~/.codex/memories/codex-ctx/projects/<cwd>/memory`.
- Searches project snapshots with lightweight keyword + recency ranking.
- Installs Codex hooks for memory restore, prompt recall, pre-tool blocking, output caching, permission checks, and stop-time snapshots.
- Exposes a small MCP server with cache-backed wrappers:
  - `codex_ctx_status`
  - `codex_ctx_snapshot`
  - `codex_ctx_ask`
  - `codex_ctx_history`
  - `codex_ctx_shell`
  - `codex_ctx_read`
  - `codex_ctx_cache_get`
  - `codex_ctx_report`
  - `codex_ctx_timeline`
  - `codex_ctx_metrics`
  - `codex_ctx_heavy`
  - `codex_ctx_bloat`
  - `codex_ctx_diff`
  - `codex_ctx_prune`

## CLI

```bash
./bin/cctx status
./bin/cctx history 20
./bin/cctx snapshot --name checkpoint
./bin/cctx ask "previous context"
./bin/cctx report
./bin/cctx timeline 20
./bin/cctx metrics --json
./bin/cctx heavy 10
./bin/cctx bloat
./bin/cctx compact --name before-refactor
./bin/cctx diff
./bin/cctx file ./large.log
./bin/cctx notes add "remember this decision"
./bin/cctx backup
./bin/cctx prune --days 30
./bin/cctx prune --days 30 --yes
./bin/cctx doctor
./bin/cctx install-hooks --dry-run
./bin/cctx install-hooks
./bin/cctx install-plugin
./bin/cctx install-all
./bin/cctx serve
```

## Storage

Default app data lives under:

```text
~/.codex/memories/codex-ctx
```

Override with:

```bash
CCTX_HOME=/some/path ./bin/cctx status
```

## Codex plugin

The plugin manifest is at:

```text
.codex-plugin/plugin.json
```

It registers `./bin/cctx serve` as an MCP server through `.mcp.json` and includes one skill in `skills/codex-ctx/SKILL.md`.

`cctx install-plugin` enables the local marketplace:

```toml
[marketplaces.local-tools]
source_type = "local"
source = "/Users/tugayoktayokay/tools"

[plugins."codex-ctx@local-tools"]
enabled = true
```

## Claude Code Ctx parity

`codex-ctx` now carries Codex-native equivalents for the highest-value `claude-code-ctx` features: report/analyze, timeline, stats/metrics/usage, heavy-output audit, bloat audit, compact snapshot prompt, snapshot diff, backups, notes, prune/purge, setup/plugin-fix, version, hooks, MCP cache wrappers, and install doctor checks.

Some Claude-specific behavior is intentionally adapted instead of copied: Claude transcript parsing, `PreCompact`, statusline integration, and long-running daemon/watch behavior do not have the same Codex runtime surface. In Codex, those features are backed by `~/.codex/history.jsonl`, snapshot memory, hook logs, and cache files.

## Current limits

Codex hooks are supported through `~/.codex/hooks.json` when the feature flag is enabled:

```toml
[features]
codex_hooks = true
```

`cctx install-hooks` writes that flag and installs `~/.codex/hooks.json`.

The implementation intentionally avoids relying on fail-open hook decisions. Heavy or destructive Bash patterns are blocked in `PreToolUse`, large outputs are cached and replaced in `PostToolUse`, and recall context is injected in `SessionStart` / `UserPromptSubmit`.
