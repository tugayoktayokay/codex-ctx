'use strict';

const fs = require('fs');
const path = require('path');
const { APP_HOME, USER_CONFIG_PATH } = require('./paths.js');

const DEFAULT_PATH = path.join(__dirname, '..', 'config.default.json');
const USER_PATH = path.join(APP_HOME, 'config.json');
const DEPRECATED_POLICY_RULE_MATCHES = new Set([
  "^\\s*(npm|pnpm|yarn)\\s+(run\\s+)?(test|dev|start)(\\s|$)(?!.*(--watch=false|--runInBand|--silent|--ci|2>&1\\s*\\|\\s*tail|-n\\s*\\d+))",
]);

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function mergeDeep(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (Array.isArray(base[key]) && Array.isArray(value) && ['rules', 'deny_patterns', 'block_secret_patterns'].includes(key)) {
      if (value.length === 0) {
        out[key] = [];
        continue;
      }
      const seen = new Set();
      out[key] = [...base[key], ...value].filter(item => {
        if (key === 'rules' && item && typeof item === 'object' && DEPRECATED_POLICY_RULE_MATCHES.has(String(item.match || ''))) return false;
        const marker = typeof item === 'object' ? JSON.stringify(item) : String(item);
        if (seen.has(marker)) return false;
        seen.add(marker);
        return true;
      });
    } else if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = mergeDeep(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function tomlValue(raw, key, section = '') {
  let current = '';
  for (const line of String(raw || '').split('\n')) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      current = header[1];
      continue;
    }
    if (current !== section) continue;
    const match = line.match(new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(.+?)\\s*$`));
    if (match) return match[1].replace(/\s+#.*$/, '').trim();
  }
  return '';
}

function codexConfigOverrides() {
  let raw = '';
  try { raw = fs.readFileSync(USER_CONFIG_PATH, 'utf8'); } catch { return {}; }
  const profile = tomlValue(raw, 'profile').match(/^"([^"]+)"$/)?.[1];
  const configured = profile ? tomlValue(raw, 'model_context_window', `profiles.${profile}`) : '';
  const window = Number((configured || tomlValue(raw, 'model_context_window')).match(/^\d+$/)?.[0]);
  if (!Number.isFinite(window) || window <= 0) return {};
  return {
    limits: {
      models: {
        default: { max: window, quality_ceiling: Math.floor(window * 0.8) },
      },
    },
  };
}

function ensureUserConfig() {
  fs.mkdirSync(path.dirname(USER_PATH), { recursive: true });
  const defaults = readJson(DEFAULT_PATH);
  if (!fs.existsSync(USER_PATH)) {
    fs.writeFileSync(USER_PATH, JSON.stringify(defaults, null, 2) + '\n');
    return true;
  }
  const current = readJson(USER_PATH);
  const merged = mergeDeep(defaults, current);
  const before = JSON.stringify(current, null, 2) + '\n';
  const after = JSON.stringify(merged, null, 2) + '\n';
  if (after !== before) {
    fs.writeFileSync(USER_PATH, after);
    return true;
  }
  return false;
}

function loadConfig() {
  const defaults = readJson(DEFAULT_PATH);
  const user = readJson(USER_PATH);
  return mergeDeep(mergeDeep(defaults, codexConfigOverrides()), user);
}

module.exports = {
  DEFAULT_PATH,
  USER_PATH,
  ensureUserConfig,
  loadConfig,
  mergeDeep,
  codexConfigOverrides,
};
