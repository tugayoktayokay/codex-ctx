'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { APP_HOME, HOOK_LOG } = require('./paths.js');
const { latestSnapshot, writeSnapshot } = require('./snapshot.js');
const { searchSnapshots } = require('./search.js');
const { loadHistory } = require('./codex_history.js');
const { estimateTokens, detectLevel } = require('./token.js');
const { writeCache, summarize } = require('./cache.js');
const { appendEvent } = require('./events.js');

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
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: event,
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
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
    if ((config?.hooks?.user_prompt_submit?.compact_hint_levels || []).includes(contextMetric.level)) {
      return hookContext('UserPromptSubmit', `[codex-ctx] Context level is ${contextMetric.level} (${Math.round(contextMetric.pct * 100)}%). Consider cctx compact --name checkpoint before continuing.`);
    }
    return null;
  }

  const top = results[0];
  const preview = top.body.split('\n').slice(0, 42).join('\n');
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
    `[codex-ctx] Relevant project memory, score ${top.score.toFixed(2)} from ${path.basename(top.path)}:\n\n${preview}${compactHint}`,
  );
}

function handlePreToolUse(input, config) {
  const pre = config?.hooks?.pre_tool_use || {};
  if (pre.enabled === false) return null;
  const toolName = getToolName(input);
  const cmd = getCommand(input);
  appendEvent(getCwd(input), {
    type: 'pre_tool_use',
    session_id: getSessionId(input),
    tool_name: toolName,
    command: cmd,
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
    const reason = `codex-ctx: ${rule.reason || 'blocked by policy'}`;
    const pattern = String(rule.match).replace(/"/g, '\\"');
    const head = probe.slice(0, 220).replace(/"/g, '\\"').replace(/\n/g, ' ');
    logHook(`pre_tool block tool=${toolName || '-'} pattern="${pattern}" input="${head}"`);
    appendEvent(getCwd(input), {
      type: 'pre_tool_use_decision',
      session_id: getSessionId(input),
      tool_name: toolName,
      command: cmd,
      decision: 'block',
      reason,
      pattern: rule.match,
    }, config);
    return decisionBlock(reason, 'PreToolUse');
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
      permission_decision: 'deny',
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
  const text = extractToolText(input);
  const bytes = Buffer.byteLength(text || '');
  const head = (cmd || JSON.stringify(getToolInput(input))).slice(0, 220).replace(/"/g, '\\"').replace(/\n/g, ' ');
  logHook(`post_tool tool=${toolName} bytes=${bytes} input="${head}"`);
  appendEvent(getCwd(input), {
    type: 'post_tool_use',
    session_id: getSessionId(input),
    tool_name: toolName,
    command: cmd,
    tool_input: getToolInput(input),
    bytes,
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
    return null;
  }

  const cached = writeCache(text, config);
  if (toolName === 'Bash') recordBashCall(getCwd(input), cmd, { ref: cached.ref, bytes: cached.bytes });
  const summary = summarize(text, Number(config?.cache?.summary_bytes || 1200));
  const msg = [
    `[codex-ctx] Large ${toolName} output was cached instead of kept inline.`,
    `ref: ${cached.ref}`,
    `bytes: ${cached.bytes}`,
    '',
    summary,
    '',
    `Use codex_ctx_cache_get({ "ref": "${cached.ref}", "offset": 0, "limit": 5000 }) for full output.`,
  ].join('\n');
  logHook(`post_tool cached ref=${cached.ref} bytes=${cached.bytes}`);
  appendEvent(getCwd(input), {
    type: 'cache_write',
    session_id: getSessionId(input),
    tool_name: toolName,
    command: cmd,
    bytes: cached.bytes,
    cache_ref: cached.ref,
  }, config);
  return {
    decision: 'block',
    reason: msg,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: msg,
    },
  };
}

function handleStop(input, config) {
  const rows = loadHistory(config?.snapshot?.history_limit || 80);
  const text = rows.map(r => r.text).join('\n');
  const metric = detectLevel(estimateTokens(text, config), config);
  const levels = config?.hooks?.stop?.snapshot_on || [];
  if (levels.includes(metric.level)) {
    const result = writeSnapshot(getCwd(input), config, { name: `stop-${metric.level}` });
    if (result) {
      logHook(`stop snapshot level=${metric.level} file="${path.basename(result.outPath)}"`);
      appendEvent(getCwd(input), {
        type: 'snapshot',
        session_id: getSessionId(input),
        reason: `stop-${metric.level}`,
        level: metric.level,
        snapshot_path: result.outPath,
      }, config);
    }
  } else {
    logHook(`stop level=${metric.level} snapshot=skip`);
  }
  appendEvent(getCwd(input), {
    type: 'stop',
    session_id: getSessionId(input),
    level: metric.level,
    tokens: metric.tokens,
  }, config);
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
