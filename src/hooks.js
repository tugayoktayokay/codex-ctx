'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { APP_HOME, HOOK_LOG } = require('./paths.js');
const { latestSnapshot, writeSnapshot } = require('./snapshot.js');
const { searchSnapshots, isGenericPrompt } = require('./search.js');
const { loadHistory } = require('./codex_history.js');
const { estimateTokens, detectLevel } = require('./token.js');
const { writeCache, summarize } = require('./cache.js');
const { appendEvent, readEvents } = require('./events.js');
const memory = require('./memory.js');

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

function safeParse(raw) {
  if (!raw || !raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function logHook(line) {
  try {
    fs.mkdirSync(path.dirname(HOOK_LOG), { recursive: true });
    const maxBytes = 1024 * 1024;
    try {
      const st = fs.statSync(HOOK_LOG);
      if (st.size > maxBytes) {
        try { fs.unlinkSync(`${HOOK_LOG}.1`); } catch {}
        fs.renameSync(HOOK_LOG, `${HOOK_LOG}.1`);
      }
    } catch {}
    fs.appendFileSync(HOOK_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

function hookContext(event, additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext,
    },
  };
}

function decisionBlock(reason, event = 'PreToolUse') {
  return {
    hookSpecificOutput: {
      hookEventName: event,
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function shellExample(command) {
  return `codex_ctx_shell({ "command": ${JSON.stringify(String(command || 'COMMAND'))}, "timeout_ms": 30000 })`;
}

function readExample(command) {
  const m = String(command || '').match(/\b(?:cat|head|tail)\b\s+(?:-[^\s]+\s+)?([^\s|;&]+)/);
  const file = m ? m[1] : 'PATH';
  return `codex_ctx_read({ "path": ${JSON.stringify(file)} })`;
}

function guidanceForRule(rule, command) {
  const match = String(rule?.match || '');
  if (/cat|head|tail|lock/.test(match)) return readExample(command);
  if (/grep|rg|find|ls|tree|journalctl|dmesg|docker|kubectl|git|npm|pnpm|yarn/.test(match)) return shellExample(command);
  return null;
}

function permissionReason(rule, command, reason) {
  const example = guidanceForRule(rule, command);
  if (!example) return reason;
  return [
    reason,
    `Example tool call: ${example}`,
    'Do not abandon: use the example tool call, or run a narrower bounded command.',
  ].join('\n');
}

function getCwd(input) {
  return input.cwd || input.workspace || process.cwd();
}

function getPrompt(input) {
  return String(input.prompt || input.user_prompt || input.input || '').trim();
}

function getToolName(input) {
  return String(input.tool_name || input.toolName || input.tool || '');
}

function getToolInput(input) {
  return input.tool_input || input.toolInput || input.input || {};
}

function getSessionId(input) {
  return input.session_id || input.sessionId || input.conversation_id || null;
}

function getCommand(input) {
  const ti = getToolInput(input);
  return String(ti.command || ti.cmd || input.command || '');
}

function normalizeCommand(command) {
  let cmd = String(command || '').trim().replace(/\s+/g, ' ');
  cmd = cmd.replace(/\s+(2>&1\s*)?\|\s*(tail|head)\s+(-n\s*)?\d+\s*$/i, '');
  cmd = cmd.replace(/\s+--watch=false\b/g, '').replace(/\s+--runInBand\b/g, '').replace(/\s+--silent\b/g, '');
  cmd = cmd.replace(/^(npm|pnpm|yarn)\s+run\s+test\b/i, '$1 test');
  cmd = cmd.replace(/^npx\s+jest\b/i, 'npm test');
  cmd = cmd.replace(/^(pnpm|yarn)\s+test\b/i, 'npm test');
  cmd = cmd.replace(/^npm\s+test\b/i, 'npm test');
  cmd = cmd.replace(/\s+--\s*$/g, '');
  return cmd.slice(0, 240);
}

function responseExitCode(input) {
  const r = input?.tool_response || input?.toolResponse || {};
  const raw = r.exit_code ?? r.exitCode ?? r.status ?? r.code;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function responseStderr(input) {
  const r = input?.tool_response || input?.toolResponse || {};
  return String(r.stderr || r.error || '');
}

function isFailureOutput(input, text) {
  const code = responseExitCode(input);
  if (code && code !== 0) return true;
  const stderr = responseStderr(input);
  if (stderr && /\b(error|failed|failure|exception|traceback|panic|segmentation fault)\b/i.test(stderr)) return true;
  const r = input?.tool_response || input?.toolResponse || {};
  const explicitError = r.error || r.exception;
  return Boolean(explicitError);
}

function latestMatchingStart(cwd, event) {
  return readEvents(cwd, { limit: 80 }).reverse().find(e => e.type === 'pre_tool_use'
    && e.session_id === event.session_id
    && e.tool_name === event.tool_name
    && e.normalized_command === event.normalized_command
    && e.started_at);
}

function commandStats(cwd, normalized) {
  if (!normalized) return null;
  const matches = readEvents(cwd, { limit: 300 })
    .filter(e => e.normalized_command === normalized && (e.type === 'post_tool_use' || e.type === 'cache_write'));
  if (!matches.length) return null;
  const bytes = matches.map(e => Number(e.bytes || 0)).filter(Boolean);
  const durations = matches.map(e => Number(e.duration_ms || 0)).filter(Boolean);
  const cached = matches.filter(e => e.type === 'cache_write' || e.cache_ref);
  const failures = matches.filter(e => e.failed);
  return {
    count: matches.length,
    avgBytes: bytes.length ? Math.round(bytes.reduce((a, b) => a + b, 0) / bytes.length) : 0,
    avgDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
    cachedCount: cached.length,
    lastRef: [...cached].reverse().find(e => e.cache_ref)?.cache_ref,
    failureCount: failures.length,
  };
}

function costAdvice(cwd, command, config = {}) {
  const cfg = config?.hooks?.pre_tool_use?.cost_advice || {};
  if (cfg.enabled === false) return null;
  const normalized = normalizeCommand(command);
  const stats = commandStats(cwd, normalized);
  if (!stats || stats.count < Number(cfg.min_runs || 2)) return null;
  const hints = [];
  const largeBytes = Number(cfg.large_output_bytes || config?.hooks?.post_tool_use?.large_output_bytes || config?.cache?.inline_limit_bytes || 5000);
  const slowMs = Number(cfg.slow_ms || 30000);
  if (stats.cachedCount >= 1 || stats.avgBytes >= largeBytes) hints.push(`large output history avg=${stats.avgBytes} bytes${stats.lastRef ? ` last_ref=${stats.lastRef}` : ''}`);
  if (stats.avgDurationMs >= slowMs) hints.push(`slow history avg=${stats.avgDurationMs}ms`);
  if (stats.failureCount) hints.push(`failed before ${stats.failureCount}/${stats.count} runs`);
  if (!hints.length) return null;
  return [
    `[codex-ctx] Cost-aware command advice for "${normalized}":`,
    `- ${hints.join('\n- ')}`,
    '- Consider narrowing output, adding `2>&1 | tail -80`, or using a cached wrapper when full output is not needed.',
  ].join('\n');
}

function failureRecallContext(cwd, failureText, config = {}) {
  const cfg = config?.hooks?.post_tool_use?.failure_recall || {};
  if (cfg.enabled === false) return null;
  const query = String(failureText || '').replace(/\s+/g, ' ').slice(0, 500);
  const facts = memory.recallFacts(cwd, query, config, { limit: Number(cfg.fact_limit || 3), minScore: Number(cfg.min_score || 0.4) });
  const snapshots = searchSnapshots(cwd, query, {
    ...config,
    retrieval: { ...config.retrieval, min_score: Number(cfg.snapshot_min_score || 0.08), top_n: Number(cfg.snapshot_limit || 2) },
  }).slice(0, Number(cfg.snapshot_limit || 2));
  if (!facts.length && !snapshots.length) return null;
  const rows = ['[codex-ctx] Similar prior failure/fix context:'];
  for (const f of facts) rows.push(`- [fact:${f.kind}] ${String(f.text || '').slice(0, 180)}`);
  for (const s of snapshots) rows.push(`- [snapshot] ${path.basename(s.path)} score=${s.score.toFixed(2)}`);
  return rows.join('\n');
}

function bashKey(cwd, cmd) {
  return crypto.createHash('sha256').update(`${cwd}\n${cmd}`).digest('hex').slice(0, 20);
}

function bashStatePath() {
  return path.join(APP_HOME, 'hooks-state', 'bash-calls.json');
}

function readBashState() {
  try { return JSON.parse(fs.readFileSync(bashStatePath(), 'utf8')); } catch { return {}; }
}

function writeBashState(state) {
  try {
    fs.mkdirSync(path.dirname(bashStatePath()), { recursive: true });
    fs.writeFileSync(bashStatePath(), JSON.stringify(state, null, 2) + '\n');
  } catch {}
}

function recordBashCall(cwd, cmd, info = {}) {
  if (!cmd) return;
  const state = readBashState();
  state[bashKey(cwd, cmd)] = {
    ts: new Date().toISOString(),
    cwd,
    cmd,
    ref: info.ref || null,
    bytes: info.bytes || 0,
  };
  writeBashState(state);
}

function repeatedBashDecision(cwd, cmd, config = {}) {
  const dedup = config?.hooks?.pre_tool_use?.dedup || {};
  if (dedup.enabled === false || !cmd) return null;
  const prior = readBashState()[bashKey(cwd, cmd)];
  if (!prior) return null;
  const minBytes = Number(dedup.min_bytes || 65536);
  if (!prior.ref || Number(prior.bytes || 0) < minBytes) return null;
  const windowMs = Number(dedup.window_sec || 90) * 1000;
  const elapsed = Date.now() - Date.parse(prior.ts || 0);
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > windowMs) return null;
  const refPart = ` Use codex_ctx_cache_get({ "ref": "${prior.ref}", "offset": 0, "limit": 5000 }) instead.`;
  return `codex-ctx: duplicate Bash command within ${Math.round(windowMs / 1000)}s.${refPart}`;
}

function extractToolText(input) {
  const tr = input.tool_response || input.toolResponse || input.response || input.output || {};
  if (typeof tr === 'string') return tr;
  if (typeof tr.stdout === 'string' || typeof tr.stderr === 'string') {
    return `${tr.stdout || ''}${tr.stderr ? `\n--- stderr ---\n${tr.stderr}` : ''}`;
  }
  if (typeof tr.content === 'string') return tr.content;
  if (typeof tr.text === 'string') return tr.text;
  try { return JSON.stringify(tr, null, 2); } catch { return ''; }
}

function conciseSnapshotPreview(snapshot, auto = {}) {
  const lines = String(snapshot.body || '').split('\n');
  const title = lines.find(line => line.startsWith('# ')) || `# ${path.basename(snapshot.path)}`;
  if (auto.brief !== false) {
    const maxSignals = Math.max(0, Number(auto.max_signals ?? 0));
    if (maxSignals === 0) return title;
    const signalMaxChars = Math.max(40, Number(auto.signal_max_chars || 80));
    const decisions = [];
    let inDecisions = false;
    const noisySignalRe = /\b(curl|node -e|git\s+(add|commit|push)|password|token|authorization|secret|api[_-]?key|email)\b/i;
    for (const line of lines) {
      if (line.startsWith('## ')) inDecisions = /^## Decisions/.test(line);
      else if (inDecisions && line.startsWith('- ') && !/\(none\)/.test(line)) {
        const signal = line.replace(/\s+/g, ' ').trim();
        if (!noisySignalRe.test(signal)) decisions.push(signal.slice(0, signalMaxChars));
      }
      if (decisions.length >= maxSignals) break;
    }
    return [title, ...decisions].join('\n');
  }
  const maxLines = Math.max(1, Number(auto.max_lines || 10));
  const maxBytes = Math.max(200, Number(auto.max_bytes || 1200));
  let preview = lines.slice(0, maxLines).join('\n');
  if (Buffer.byteLength(preview) > maxBytes) preview = preview.slice(0, maxBytes) + '\n...[truncated by codex-ctx]';
  return preview;
}

function contextBudgetBytes(contextMetric, config = {}, auto = {}) {
  const charsPerToken = Number(config?.limits?.chars_per_token || 4);
  const remainingTokens = Math.max(0, Number(contextMetric.ceiling || 0) - Number(contextMetric.tokens || 0));
  const pct = Number(auto.budget_available_pct || config?.retrieval?.budget_available_pct || 0.05);
  const capTokens = Number(auto.max_budget_tokens || config?.retrieval?.max_inject_tokens || 6000);
  const minTokens = Number(auto.min_budget_tokens || 300);
  const levelCap = ['compact', 'urgent', 'critical'].includes(contextMetric.level) ? Math.min(capTokens, 800) : capTokens;
  return Math.max(minTokens, Math.min(levelCap, Math.floor(remainingTokens * pct))) * charsPerToken;
}

function trimToBytes(text, maxBytes) {
  const raw = String(text || '');
  if (Buffer.byteLength(raw) <= maxBytes) return raw;
  return raw.slice(0, Math.max(0, maxBytes)) + '\n...[truncated by codex-ctx budget]';
}

function budgetedMemoryContext(cwd, prompt, snapshots, contextMetric, config = {}, auto = {}) {
  const budget = contextBudgetBytes(contextMetric, config, auto);
  const facts = memory.recallFacts(cwd, prompt, config, { limit: Number(auto.fact_top_n || 5), minScore: Number(auto.fact_min_score || config?.memory?.min_score || 0.6) });
  const snapshotLimit = Math.max(1, Number(auto.budget_snapshot_top_n || Math.min(3, snapshots.length)));
  const sections = [`[codex-ctx] Memory budget ${Math.round(budget / 1024)}KB (${contextMetric.level}, ${Math.round(contextMetric.pct * 100)}% used)`];
  for (const r of snapshots.slice(0, snapshotLimit)) {
    sections.push(`\n## Snapshot ${path.basename(r.path)} score=${r.score.toFixed(2)}\n${conciseSnapshotPreview(r, { ...auto, brief: auto.brief_budget !== false, max_signals: auto.max_signals ?? 3 })}`);
  }
  if (facts.length) {
    sections.push('\n## Facts');
    for (const f of facts) sections.push(`- ${f.kind} score=${f.score.toFixed(2)} ${String(f.text || '').slice(0, 220)}`);
  }
  const recent = readEvents(cwd, { limit: 40 }).filter(e => e.file_path || e.command).slice(-8);
  if (recent.length && budget > 2400) {
    sections.push('\n## Recent Work');
    for (const e of recent) sections.push(`- ${e.type} ${String(e.file_path || e.command || '').replace(/\s+/g, ' ').slice(0, 180)}`);
  }
  return trimToBytes(sections.join('\n'), budget);
}

function handleSessionStart(input, config) {
  const cfg = config?.hooks?.session_start || {};
  if (cfg.restore_latest === false) return null;
  const cwd = getCwd(input);
  const latest = latestSnapshot(cwd, config);
  if (!latest) return null;

  let content;
  try { content = fs.readFileSync(latest.path, 'utf8'); } catch { return null; }
  const maxBytes = Number(cfg.max_bytes || 8192);
  const trimmed = content.length > maxBytes
    ? `${content.slice(0, maxBytes)}\n\n...[truncated by codex-ctx]`
    : content;
  logHook(`session_start restored="${path.basename(latest.path)}" bytes=${trimmed.length}`);
  appendEvent(cwd, {
    type: 'session_start',
    session_id: getSessionId(input),
    snapshot_path: latest.path,
    bytes: trimmed.length,
  }, config);
  return hookContext('SessionStart', `[codex-ctx] Most recent project memory:\n\n${trimmed}`);
}

function handleUserPromptSubmit(input, config) {
  const cwd = getCwd(input);
  const prompt = getPrompt(input);
  if (!prompt) return null;
  appendEvent(cwd, {
    type: 'user_prompt_submit',
    session_id: getSessionId(input),
    prompt,
  }, config);
  const contextRows = loadHistory(config?.snapshot?.history_limit || 80);
  const contextMetric = detectLevel(estimateTokens(contextRows.map(r => r.text).join('\n'), config), config);

  for (const pattern of config?.hooks?.user_prompt_submit?.block_secret_patterns || []) {
    try {
      if (new RegExp(pattern).test(prompt)) {
        logHook(`user_prompt_submit blocked_secret pattern="${String(pattern).replace(/"/g, '\\"')}"`);
        appendEvent(cwd, {
          type: 'user_prompt_submit_block',
          session_id: getSessionId(input),
          decision: 'block',
          reason: 'secret pattern',
          pattern,
        }, config);
        return decisionBlock('codex-ctx blocked a prompt that appears to contain a secret.', 'UserPromptSubmit');
      }
    } catch {}
  }

  const auto = config?.hooks?.user_prompt_submit?.auto_retrieve || {};
  if (!auto.enabled) {
    if ((config?.hooks?.user_prompt_submit?.compact_hint_levels || []).includes(contextMetric.level)) {
      return hookContext('UserPromptSubmit', `[codex-ctx] Context level is ${contextMetric.level} (${Math.round(contextMetric.pct * 100)}%). Consider cctx compact --name checkpoint before continuing.`);
    }
    return null;
  }
  if (isGenericPrompt(prompt, config)) {
    logHook(`auto_retrieve skip_generic prompt="${prompt.slice(0, 120).replace(/"/g, '\\"')}"`);
    appendEvent(cwd, {
      type: 'auto_retrieve_skip',
      session_id: getSessionId(input),
      prompt,
      reason: 'generic_prompt',
    }, config);
    return null;
  }
  const cfg = {
    ...config,
    retrieval: {
      ...config.retrieval,
      min_score: Number(auto.min_score || config?.retrieval?.min_score || 0.1),
      top_n: Number(auto.top_n || 1),
    },
  };
  const results = searchSnapshots(cwd, prompt, cfg);
  if (!results.length) {
    if (config?.memory?.prompt_nudge !== false) {
      const nudge = memory.buildNudge(cwd, prompt, config);
      if (nudge) return hookContext('UserPromptSubmit', nudge);
    }
    if ((config?.hooks?.user_prompt_submit?.compact_hint_levels || []).includes(contextMetric.level)) {
      return hookContext('UserPromptSubmit', `[codex-ctx] Context level is ${contextMetric.level} (${Math.round(contextMetric.pct * 100)}%). Consider cctx compact --name checkpoint before continuing.`);
    }
    return null;
  }

  const top = results[0];
  const preview = auto.budget_aware === false
    ? conciseSnapshotPreview(top, auto)
    : budgetedMemoryContext(cwd, prompt, results, contextMetric, config, auto);
  logHook(`auto_retrieve score=${top.score.toFixed(2)} file="${path.basename(top.path)}"`);
  appendEvent(cwd, {
    type: 'auto_retrieve',
    session_id: getSessionId(input),
    prompt,
    snapshot_path: top.path,
    score: top.score,
  }, config);
  const compactHint = (config?.hooks?.user_prompt_submit?.compact_hint_levels || []).includes(contextMetric.level)
    ? `\n\n[codex-ctx] Context level is ${contextMetric.level} (${Math.round(contextMetric.pct * 100)}%). Consider cctx compact --name checkpoint before continuing.`
    : '';
  return hookContext(
    'UserPromptSubmit',
    `[codex-ctx] Memory hit ${top.score.toFixed(2)}: ${path.basename(top.path)}\n${preview}${compactHint}`,
  );
}

function handlePreToolUse(input, config) {
  const pre = config?.hooks?.pre_tool_use || {};
  if (pre.enabled === false) return null;
  const toolName = getToolName(input);
  const cmd = getCommand(input);
  const normalizedCommand = normalizeCommand(cmd);
  const startedAt = new Date().toISOString();
  appendEvent(getCwd(input), {
    type: 'pre_tool_use',
    session_id: getSessionId(input),
    tool_name: toolName,
    command: cmd,
    normalized_command: normalizedCommand,
    started_at: startedAt,
    tool_input: getToolInput(input),
  }, config);

  if (toolName === 'Bash') {
    const duplicate = repeatedBashDecision(getCwd(input), cmd, config);
    if (duplicate) {
      logHook(`pre_tool duplicate_bash input="${cmd.slice(0, 220).replace(/"/g, '\\"').replace(/\n/g, ' ')}"`);
      appendEvent(getCwd(input), {
        type: 'pre_tool_use_decision',
        session_id: getSessionId(input),
        tool_name: toolName,
        command: cmd,
        normalized_command: normalizedCommand,
        decision: 'block',
        reason: duplicate,
      }, config);
      return decisionBlock(duplicate, 'PreToolUse');
    }
  }

  for (const rule of pre.rules || []) {
    if (rule.tool && rule.tool !== toolName) continue;
    const probe = String(rule.field ? getToolInput(input)[rule.field] || '' : cmd);
    try {
      const re = new RegExp(rule.match);
      if (!re.test(probe)) continue;
    } catch { continue; }
    const reason = permissionReason(rule, cmd, `codex-ctx: ${rule.reason || 'blocked by policy'}`);
    const pattern = String(rule.match).replace(/"/g, '\\"');
    const head = probe.slice(0, 220).replace(/"/g, '\\"').replace(/\n/g, ' ');
    logHook(`pre_tool block tool=${toolName || '-'} pattern="${pattern}" input="${head}"`);
    appendEvent(getCwd(input), {
      type: 'pre_tool_use_decision',
      session_id: getSessionId(input),
      tool_name: toolName,
      command: cmd,
      normalized_command: normalizedCommand,
      decision: 'block',
      reason,
      pattern: rule.match,
    }, config);
    return decisionBlock(reason, 'PreToolUse');
  }
  const advice = toolName === 'Bash' ? costAdvice(getCwd(input), cmd, config) : null;
  if (advice) {
    logHook(`pre_tool advice input="${cmd.slice(0, 220).replace(/"/g, '\\"').replace(/\n/g, ' ')}"`);
    appendEvent(getCwd(input), {
      type: 'pre_tool_use_advice',
      session_id: getSessionId(input),
      tool_name: toolName,
      command: cmd,
      normalized_command: normalizedCommand,
      advice,
    }, config);
  }
  return null;
}

function handlePermissionRequest(input, config) {
  const cmd = getCommand(input);
  const cwd = getCwd(input);
  for (const pattern of config?.hooks?.permission_request?.deny_patterns || []) {
    try {
      if (!new RegExp(pattern).test(cmd)) continue;
    } catch { continue; }
    const head = cmd.slice(0, 220).replace(/"/g, '\\"').replace(/\n/g, ' ');
    logHook(`permission_request block input="${head}"`);
    appendEvent(cwd, {
      type: 'permission_request',
      session_id: getSessionId(input),
      command: cmd,
      decision: 'block',
      pattern,
    }, config);
    return decisionBlock('codex-ctx blocked escalation for a destructive command.', 'PermissionRequest');
  }
  appendEvent(cwd, {
    type: 'permission_request',
    session_id: getSessionId(input),
    command: cmd,
    decision: 'allow',
  }, config);
  return null;
}

function handlePostToolUse(input, config) {
  const toolName = getToolName(input) || '-';
  const cmd = getCommand(input);
  const normalizedCommand = normalizeCommand(cmd);
  const text = extractToolText(input);
  const bytes = Buffer.byteLength(text || '');
  const eventBase = {
    session_id: getSessionId(input),
    tool_name: toolName,
    command: cmd,
    normalized_command: normalizedCommand,
  };
  const started = latestMatchingStart(getCwd(input), eventBase);
  const durationMs = started ? Math.max(0, Date.now() - Date.parse(started.started_at || 0)) : null;
  const exitCode = responseExitCode(input);
  const failed = isFailureOutput(input, text);
  const head = (cmd || JSON.stringify(getToolInput(input))).slice(0, 220).replace(/"/g, '\\"').replace(/\n/g, ' ');
  logHook(`post_tool tool=${toolName} bytes=${bytes} input="${head}"`);
  appendEvent(getCwd(input), {
    type: 'post_tool_use',
    ...eventBase,
    tool_input: getToolInput(input),
    bytes,
    duration_ms: durationMs,
    exit_code: exitCode,
    failed,
  }, config);

  if (config?.hooks?.post_tool_use?.snapshot_on_git_commit && /^git\s+commit\b/.test(cmd)) {
    const result = writeSnapshot(getCwd(input), config, { name: 'git-commit' });
    if (result) {
      logHook(`post_tool snapshot file="${path.basename(result.outPath)}"`);
      appendEvent(getCwd(input), {
        type: 'snapshot',
        session_id: getSessionId(input),
        reason: 'git-commit',
        snapshot_path: result.outPath,
      }, config);
    }
  }

  const limit = Number(config?.hooks?.post_tool_use?.large_output_bytes || config?.cache?.inline_limit_bytes || 5000);
  if (!config?.cache?.post_tool_replace_large_output || bytes <= limit) {
    if (toolName === 'Bash') recordBashCall(getCwd(input), cmd, { bytes });
    const failureContext = failed ? failureRecallContext(getCwd(input), `${cmd}\n${responseStderr(input)}\n${text}`, config) : null;
    return failureContext ? hookContext('PostToolUse', failureContext) : null;
  }

  const cached = writeCache(text, config);
  if (toolName === 'Bash') recordBashCall(getCwd(input), cmd, { ref: cached.ref, bytes: cached.bytes });
  const hookSummaryBytes = Number(config?.cache?.hook_summary_bytes ?? 0);
  const summary = hookSummaryBytes > 0 ? summarize(text, hookSummaryBytes) : '';
  const msg = [
    `[codex-ctx] Large ${toolName} output was cached instead of kept inline.`,
    `ref: ${cached.ref}`,
    `bytes: ${cached.bytes}`,
    summary ? '' : null,
    summary || null,
    '',
    `Use codex_ctx_cache_get({ "ref": "${cached.ref}", "offset": 0, "limit": 5000 }) for full output.`,
  ].filter(line => line !== null).join('\n');
  logHook(`post_tool cached ref=${cached.ref} bytes=${cached.bytes}`);
  appendEvent(getCwd(input), {
    type: 'cache_write',
    ...eventBase,
    bytes: cached.bytes,
    duration_ms: durationMs,
    exit_code: exitCode,
    failed,
    cache_ref: cached.ref,
  }, config);
  const failureContext = failed ? `\n\n${failureRecallContext(getCwd(input), `${cmd}\n${responseStderr(input)}\n${text}`, config) || ''}`.trimEnd() : '';
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: failureContext ? `${msg}\n\n${failureContext}` : msg,
    },
  };
}

function handleStop(input, config) {
  const cwd = getCwd(input);
  const rows = loadHistory(config?.snapshot?.history_limit || 80);
  const text = rows.map(r => r.text).join('\n');
  const metric = detectLevel(estimateTokens(text, config), config);
  const stopCfg = config?.hooks?.stop || {};
  const levels = stopCfg.snapshot_on || [];
  const latest = latestSnapshot(cwd, config);
  const events = readEvents(cwd, { limit: Number(stopCfg.snapshot_event_threshold || 100) + 1 });
  const latestAgeHours = latest ? (Date.now() - latest.mtime) / 3600000 : Infinity;
  const staleHours = Number(stopCfg.snapshot_stale_hours || 24);
  let reason = null;
  if (levels.includes(metric.level)) reason = `stop-${metric.level}`;
  else if (stopCfg.snapshot_if_no_project_snapshot !== false && !latest) reason = 'stop-no-snapshot';
  else if (Number(stopCfg.snapshot_event_threshold || 0) > 0 && events.length >= Number(stopCfg.snapshot_event_threshold)) reason = `stop-events-${events.length}`;
  else if (Number.isFinite(staleHours) && staleHours > 0 && latestAgeHours >= staleHours) reason = 'stop-stale';

  if (reason) {
    const result = writeSnapshot(cwd, config, { name: reason });
    if (result) {
      logHook(`stop snapshot reason=${reason} level=${metric.level} events=${events.length} file="${path.basename(result.outPath)}"`);
      appendEvent(cwd, {
        type: 'snapshot',
        session_id: getSessionId(input),
        reason,
        level: metric.level,
        events: events.length,
        snapshot_path: result.outPath,
      }, config);
    }
  } else {
    logHook(`stop level=${metric.level} events=${events.length} snapshot=skip`);
  }
  appendEvent(cwd, {
    type: 'stop',
    session_id: getSessionId(input),
    level: metric.level,
    tokens: metric.tokens,
    events: events.length,
    snapshot_reason: reason,
  }, config);
  const retained = memory.retainFacts(cwd, config, { limit: Number(stopCfg.snapshot_event_threshold || 100) + 100 });
  if (retained.extracted) logHook(`memory retain facts=${retained.extracted} total=${retained.total}`);
  return null;
}

async function handle(eventName, input, config) {
  switch (eventName) {
    case 'session-start': return handleSessionStart(input, config);
    case 'user-prompt-submit': return handleUserPromptSubmit(input, config);
    case 'pre-tool-use': return handlePreToolUse(input, config);
    case 'permission-request': return handlePermissionRequest(input, config);
    case 'post-tool-use': return handlePostToolUse(input, config);
    case 'stop': return handleStop(input, config);
    default: return null;
  }
}

async function runHookCli(eventName, config) {
  const input = safeParse(await readStdin());
  let output = null;
  try {
    output = await handle(eventName, input, config);
  } catch (err) {
    logHook(`hook_error event=${eventName} message="${String(err.message || err).replace(/"/g, '\\"')}"`);
  }
  if (output) process.stdout.write(JSON.stringify(output));
  return 0;
}

module.exports = {
  readStdin,
  safeParse,
  logHook,
  handle,
  handleSessionStart,
  handleUserPromptSubmit,
  handlePreToolUse,
  handlePermissionRequest,
  handlePostToolUse,
  handleStop,
  runHookCli,
};
