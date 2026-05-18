'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { USER_CONFIG_PATH, USER_HOOKS_PATH, HOOK_LOG } = require('./paths.js');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const MARKETPLACE_ROOT = path.resolve(PROJECT_ROOT, '..');
const MARKETPLACE_NAME = 'local-tools';
const PLUGIN_KEY = 'codex-ctx@local-tools';
const SOURCE_HOOKS = path.join(PROJECT_ROOT, 'hooks', 'hooks.json');
const SOURCE_PLUGIN = path.join(PROJECT_ROOT, '.codex-plugin', 'plugin.json');
const SOURCE_TAG = '/codex-ctx/bin/cctx hook ';
const CCTX_BIN = path.join(PROJECT_ROOT, 'bin', 'cctx');

function readText(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

function ensureFeatureFlag(toml) {
  const raw = String(toml || '');
  if (featureFlagEnabled(raw)) {
    return raw.replace(/^\s*codex_hooks\s*=\s*true\s*\n?/m, '');
  }
  if (/\[features\][\s\S]*?^\s*codex_hooks\s*=\s*true\s*$/m.test(raw)) {
    return raw.replace(/^\s*codex_hooks\s*=\s*true\s*$/m, 'hooks = true');
  }
  if (/^\[features\]\s*$/m.test(raw)) {
    return raw.replace(/^\[features\]\s*$/m, '[features]\nhooks = true');
  }
  return `${raw.trimEnd()}\n\n[features]\nhooks = true\n`;
}

function featureFlagEnabled(toml) {
  const raw = String(toml || '');
  return /\[features\][\s\S]*?^\s*hooks\s*=\s*true\s*$/m.test(raw);
}

function safeJson(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

function packageVersion() {
  return safeJson(readText(path.join(PROJECT_ROOT, 'package.json'))).version || null;
}

function sourcePluginVersion() {
  return safeJson(readText(SOURCE_PLUGIN)).version || null;
}

function isCctxHook(hook) {
  return typeof hook?.command === 'string' && hook.command.includes(SOURCE_TAG);
}

function stripCctxHooks(groups) {
  if (!Array.isArray(groups)) return groups;
  const kept = [];
  for (const group of groups) {
    const hooks = Array.isArray(group?.hooks) ? group.hooks.filter(h => !isCctxHook(h)) : [];
    if (!group || typeof group !== 'object') {
      kept.push(group);
    } else if (hooks.length) {
      kept.push({ ...group, hooks });
    }
  }
  return kept;
}

function mergeHooks(existingRaw, sourceRaw) {
  const existing = safeJson(existingRaw);
  const source = safeJson(sourceRaw);
  const out = { ...existing, hooks: { ...(existing.hooks || {}) } };
  for (const [eventName, sourceGroups] of Object.entries(source.hooks || {})) {
    const current = stripCctxHooks(out.hooks[eventName]) || [];
    out.hooks[eventName] = [...current, ...sourceGroups];
  }
  return JSON.stringify(out, null, 2) + '\n';
}

function materializeSourceHooks(raw) {
  return String(raw || '').replaceAll('__CCTX_BIN__', CCTX_BIN);
}

function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const backupPath = `${filePath}.cctx-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function removeTomlSection(toml, sectionName) {
  const lines = String(toml || '').split('\n');
  const out = [];
  let skipping = false;
  const header = `[${sectionName}]`;
  for (const line of lines) {
    if (/^\[.+\]\s*$/.test(line)) {
      skipping = line.trim() === header;
      if (skipping) continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n').trimEnd();
}

function ensurePluginConfig(toml) {
  let out = String(toml || '');
  out = removeTomlSection(out, `marketplaces.${MARKETPLACE_NAME}`);
  out = removeTomlSection(out, `plugins."${PLUGIN_KEY}"`);
  return `${out.trimEnd()}\n\n[marketplaces.${MARKETPLACE_NAME}]\nsource_type = "local"\nsource = "${MARKETPLACE_ROOT}"\n\n[plugins."${PLUGIN_KEY}"]\nenabled = true\n`;
}

function ensureMcpConfig(toml) {
  let out = removeTomlSection(String(toml || ''), 'mcp_servers.codex-ctx');
  return `${out.trimEnd()}\n\n[mcp_servers.codex-ctx]\ncommand = "${CCTX_BIN}"\nargs = ["serve"]\nstartup_timeout_sec = 10\ntool_timeout_sec = 60\n`;
}

function writeIfChanged(filePath, before, after, dryRun) {
  let backup = null;
  if (!dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    backup = after !== before ? backupFile(filePath) : null;
    fs.writeFileSync(filePath, after);
  }
  return { changed: after !== before, backup };
}

function materializedHooksJson() {
  return materializeSourceHooks(fs.readFileSync(SOURCE_HOOKS, 'utf8'));
}

function installConfig(transform, opts = {}) {
  const dryRun = !!opts.dryRun;
  const before = readText(USER_CONFIG_PATH);
  const after = transform(before);
  const written = writeIfChanged(USER_CONFIG_PATH, before, after, dryRun);
  return {
    configPath: USER_CONFIG_PATH,
    changedConfig: written.changed,
    configBackup: written.backup,
    dryRun,
  };
}

function installHooksFile(opts = {}) {
  const dryRun = !!opts.dryRun;
  const before = readText(USER_HOOKS_PATH);
  const after = mergeHooks(before, materializedHooksJson());
  const written = writeIfChanged(USER_HOOKS_PATH, before, after, dryRun);
  return {
    hooksPath: USER_HOOKS_PATH,
    sourceHooks: SOURCE_HOOKS,
    changedHooks: written.changed,
    hooksBackup: written.backup,
    dryRun,
  };
}

function installPlugin(opts = {}) {
  const config = installConfig(toml => ensureMcpConfig(ensurePluginConfig(toml)), opts);
  return {
    ...config,
    marketplaceRoot: MARKETPLACE_ROOT,
    marketplaceName: MARKETPLACE_NAME,
    pluginKey: PLUGIN_KEY,
  };
}

function installAll(opts = {}) {
  const config = installConfig(toml => ensureMcpConfig(ensureFeatureFlag(ensurePluginConfig(toml))), opts);
  const hooksFile = installHooksFile(opts);
  const plugin = {
    ...config,
    marketplaceRoot: MARKETPLACE_ROOT,
    marketplaceName: MARKETPLACE_NAME,
    pluginKey: PLUGIN_KEY,
  };
  const hooks = {
    ...config,
    ...hooksFile,
  };
  return { plugin, hooks };
}

function installHooks(opts = {}) {
  const config = installConfig(toml => ensureMcpConfig(ensureFeatureFlag(toml)), opts);
  const hooksFile = installHooksFile(opts);
  return {
    ...config,
    ...hooksFile,
  };
}

function doctor() {
  const config = readText(USER_CONFIG_PATH);
  const hooks = readText(USER_HOOKS_PATH);
  const marketplaceRe = new RegExp(`\\[marketplaces\\.${MARKETPLACE_NAME}\\][\\s\\S]*?source\\s*=\\s*"${MARKETPLACE_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`);
  return {
    configPath: USER_CONFIG_PATH,
    hooksPath: USER_HOOKS_PATH,
    featureEnabled: featureFlagEnabled(config),
    hooksInstalled: hooks.includes('cctx hook pre-tool-use') && hooks.includes('cctx hook post-tool-use'),
    marketplaceInstalled: marketplaceRe.test(config),
    pluginEnabled: new RegExp(`\\[plugins\\."${PLUGIN_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\][\\s\\S]*?enabled\\s*=\\s*true`).test(config),
    mcpInstalled: /\[mcp_servers\.codex-ctx\][\s\S]*?command\s*=/.test(config),
    sessionStartSeen: /session_start/.test(readText(HOOK_LOG)),
    packageVersion: packageVersion(),
    sourcePluginVersion: sourcePluginVersion(),
    versionDrift: packageVersion() && sourcePluginVersion() && packageVersion() !== sourcePluginVersion(),
  };
}

function checkOk(fn) {
  try {
    const detail = fn();
    return { ok: true, detail };
  } catch (err) {
    return { ok: false, detail: err && err.message ? err.message : String(err) };
  }
}

function doctorDeep(cwd = process.cwd(), config = {}) {
  const base = doctor();
  const { writeCache, readCache } = require('./cache.js');
  const events = require('./events.js');
  const memory = require('./memory.js');
  const { allTools } = require('./mcp_tools.js');
  const checks = {
    cache_rw: checkOk(() => {
      const cached = writeCache('codex-ctx doctor deep cache smoke', config);
      const page = readCache(cached.ref);
      if (!page?.text?.includes('doctor deep')) throw new Error('cache read mismatch');
      return cached.ref;
    }),
    events_rw: checkOk(() => {
      const row = events.appendEvent(cwd, { type: 'doctor_deep', command: 'doctor --deep' }, config);
      const recent = events.readEvents(cwd, { limit: 5 });
      if (!recent.some(e => e.id === row.id)) throw new Error('event not found after append');
      return row.id;
    }),
    facts_rw: checkOk(() => {
      const remembered = memory.rememberFact(cwd, 'doctor deep smoke fact', config, { kind: 'doctor' });
      const hits = memory.recallFacts(cwd, 'doctor deep smoke', config, { minScore: 0.1 });
      memory.forgetFacts(cwd, remembered.fact.id, config, { dryRun: false });
      if (!hits.some(f => f.id === remembered.fact.id)) throw new Error('fact recall failed');
      return remembered.fact.id;
    }),
    git_status: checkOk(() => execFileSync('git', ['status', '--short'], { cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean).length),
    mcp_tools: checkOk(() => {
      const names = allTools().map(t => t.name);
      for (const name of ['codex_ctx_status', 'codex_ctx_memory_recall', 'codex_ctx_savings']) {
        if (!names.includes(name)) throw new Error(`missing ${name}`);
      }
      return names.length;
    }),
    hooks_source: checkOk(() => {
      const source = safeJson(materializedHooksJson());
      if (!source.hooks?.PreToolUse || !source.hooks?.PostToolUse) throw new Error('source hook events missing');
      return Object.keys(source.hooks).length;
    }),
  };
  return { ...base, deep: checks };
}

module.exports = {
  SOURCE_HOOKS,
  SOURCE_PLUGIN,
  MARKETPLACE_ROOT,
  MARKETPLACE_NAME,
  PLUGIN_KEY,
  ensureFeatureFlag,
  ensurePluginConfig,
  ensureMcpConfig,
  packageVersion,
  sourcePluginVersion,
  mergeHooks,
  materializeSourceHooks,
  installPlugin,
  installAll,
  installHooks,
  doctor,
  doctorDeep,
};
