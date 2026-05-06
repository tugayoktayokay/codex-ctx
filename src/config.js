'use strict';

const fs = require('fs');
const path = require('path');
const { APP_HOME } = require('./paths.js');

const DEFAULT_PATH = path.join(__dirname, '..', 'config.default.json');
const USER_PATH = path.join(APP_HOME, 'config.json');

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
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = mergeDeep(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
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
  return mergeDeep(defaults, user);
}

module.exports = {
  DEFAULT_PATH,
  USER_PATH,
  ensureUserConfig,
  loadConfig,
  mergeDeep,
};
