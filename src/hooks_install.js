'use strict';

const fs = require('fs');
const path = require('path');
const { USER_CONFIG_PATH, USER_HOOKS_PATH } = require('./paths.js');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const MARKETPLACE_ROOT = path.resolve(PROJECT_ROOT, '..');
const MARKETPLACE_NAME = 'local-tools';
const PLUGIN_KEY = 'codex-ctx@local-tools';
const SOURCE_HOOKS = path.join(PROJECT_ROOT, 'hooks', 'hooks.json');
const SOURCE_TAG = '/codex-ctx/bin/cctx hook ';
const CCTX_BIN = path.join(PROJECT_ROOT, 'bin', 'cctx');

function readText(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

function ensureFeatureFlag(toml) {
  const raw = String(toml || '');
  if (/\[features\][\s\S]*?^\s*codex_hooks\s*=\s*true\s*$/m.test(raw)) return raw;
  if (/^\[features\]\s*$/m.test(raw)) {
    return raw.replace(/^\[features\]\s*$/m, '[features]\ncodex_hooks = true');
  }
  return `${raw.trimEnd()}\n\n[features]\ncodex_hooks = true\n`;
}

function safeJson(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
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

function installPlugin(opts = {}) {
  const dryRun = !!opts.dryRun;
  const before = readText(USER_CONFIG_PATH);
  const after = ensurePluginConfig(before);
  let configBackup = null;
  if (!dryRun) {
    fs.mkdirSync(path.dirname(USER_CONFIG_PATH), { recursive: true });
    configBackup = after !== before ? backupFile(USER_CONFIG_PATH) : null;
    fs.writeFileSync(USER_CONFIG_PATH, after);
  }
  return {
    configPath: USER_CONFIG_PATH,
    marketplaceRoot: MARKETPLACE_ROOT,
    marketplaceName: MARKETPLACE_NAME,
    pluginKey: PLUGIN_KEY,
    changedConfig: after !== before,
    configBackup,
    dryRun,
  };
}

function installAll(opts = {}) {
  const plugin = installPlugin(opts);
  const hooks = installHooks(opts);
  return { plugin, hooks };
}

function installHooks(opts = {}) {
  const dryRun = !!opts.dryRun;
  const configBefore = readText(USER_CONFIG_PATH);
  const configAfter = ensureFeatureFlag(configBefore);
  const hooksBefore = readText(USER_HOOKS_PATH);
  const hooksJson = mergeHooks(hooksBefore, materializeSourceHooks(fs.readFileSync(SOURCE_HOOKS, 'utf8')));
  let configBackup = null;
  let hooksBackup = null;
  if (!dryRun) {
    fs.mkdirSync(path.dirname(USER_CONFIG_PATH), { recursive: true });
    configBackup = configAfter !== configBefore ? backupFile(USER_CONFIG_PATH) : null;
    hooksBackup = hooksJson !== hooksBefore ? backupFile(USER_HOOKS_PATH) : null;
    fs.writeFileSync(USER_CONFIG_PATH, configAfter);
    fs.writeFileSync(USER_HOOKS_PATH, hooksJson);
  }
  return {
    configPath: USER_CONFIG_PATH,
    hooksPath: USER_HOOKS_PATH,
    sourceHooks: SOURCE_HOOKS,
    changedConfig: configAfter !== configBefore,
    changedHooks: hooksJson !== hooksBefore,
    configBackup,
    hooksBackup,
    dryRun,
  };
}

function doctor() {
  const config = readText(USER_CONFIG_PATH);
  const hooks = readText(USER_HOOKS_PATH);
  const marketplaceRe = new RegExp(`\\[marketplaces\\.${MARKETPLACE_NAME}\\][\\s\\S]*?source\\s*=\\s*"${MARKETPLACE_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`);
  return {
    configPath: USER_CONFIG_PATH,
    hooksPath: USER_HOOKS_PATH,
    featureEnabled: /\[features\][\s\S]*?^\s*codex_hooks\s*=\s*true\s*$/m.test(config),
    hooksInstalled: hooks.includes('cctx hook pre-tool-use') && hooks.includes('cctx hook post-tool-use'),
    marketplaceInstalled: marketplaceRe.test(config),
    pluginEnabled: new RegExp(`\\[plugins\\."${PLUGIN_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\][\\s\\S]*?enabled\\s*=\\s*true`).test(config),
  };
}

module.exports = {
  SOURCE_HOOKS,
  MARKETPLACE_ROOT,
  MARKETPLACE_NAME,
  PLUGIN_KEY,
  ensureFeatureFlag,
  ensurePluginConfig,
  mergeHooks,
  materializeSourceHooks,
  installPlugin,
  installAll,
  installHooks,
  doctor,
};
