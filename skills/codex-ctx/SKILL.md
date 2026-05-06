---
name: codex-ctx
description: Use Codex Ctx when the task benefits from local Codex memory recall, creating a project snapshot, checking context size, or wrapping potentially large shell/file output through cache-backed MCP tools.
---

# Codex Ctx

Use `cctx` for local memory and context management:

- `cctx status` checks local Codex history and latest memory snapshot.
- `cctx snapshot --name <label>` writes a project memory snapshot from recent Codex prompts.
- `cctx ask "<query>"` searches project snapshots.
- `cctx report`, `cctx timeline`, `cctx metrics`, `cctx heavy`, and `cctx bloat` inspect project context health.
- `cctx statusline` prints a one-line context summary; `cctx watch --interval 5` repeats it.
- `cctx compact`, `cctx diff`, `cctx backup`, `cctx notes`, and `cctx prune` manage local project memory.
- `cctx install-hooks` enables Codex hooks and installs `~/.codex/hooks.json`.
- `cctx doctor` checks whether hook support is enabled and installed.
- `cctx serve` starts the MCP server exposing status, snapshot, ask, history, shell/read cache wrappers, cache paging, report, timeline, metrics, heavy, bloat, statusline, diff, and prune tools.

Prefer the MCP wrappers for commands or files likely to return more than a few KB.
