'use strict';

const os = require('os');
const path = require('path');

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const APP_HOME = process.env.CCTX_HOME || path.join(CODEX_HOME, 'memories', 'codex-ctx');
const HOOK_LOG = path.join(APP_HOME, 'hooks.log');
const USER_HOOKS_PATH = path.join(CODEX_HOME, 'hooks.json');
const USER_CONFIG_PATH = path.join(CODEX_HOME, 'config.toml');

function encodeCwd(cwd) {
  return '-' + String(cwd || process.cwd()).replace(/^\//, '').replace(/[^a-zA-Z0-9]+/g, '-');
}

function projectDirFor(cwd) {
  return path.join(APP_HOME, 'projects', encodeCwd(cwd));
}

function memoryDirFor(cwd, config = {}) {
  const template = config?.snapshot?.memory_dir || '{project_dir}/memory';
  return template
    .replace('{project_dir}', projectDirFor(cwd))
    .replace('{cwd_hash}', encodeCwd(cwd));
}

module.exports = {
  CODEX_HOME,
  APP_HOME,
  HOOK_LOG,
  USER_HOOKS_PATH,
  USER_CONFIG_PATH,
  encodeCwd,
  projectDirFor,
  memoryDirFor,
};
