'use strict';

const { ensureUserConfig, loadConfig, USER_PATH } = require('./config.js');
const { loadHistory, groupBySession, HISTORY_PATH } = require('./codex_history.js');
const { memoryDirFor } = require('./paths.js');
const { writeSnapshot } = require('./snapshot.js');
const { estimateTokens, detectLevel } = require('./token.js');
const { makeServer } = require('./mcp.js');
const { allTools, statusText } = require('./mcp_tools.js');
const hooks = require('./hooks.js');
const hooksInstall = require('./hooks_install.js');
const advanced = require('./advanced.js');
const memory = require('./memory.js');
const pkg = require('../package.json');

function help() {
  console.log(`cctx - Codex context helper

Usage:
  cctx status
  cctx history [N]
  cctx recent [N]
  cctx snapshot [--name NAME]
  cctx ask <query> [--since 1w|30m|2h|2026-05-08]
  cctx report|analyze
  cctx timeline [--json]
  cctx events [N] [--json]
  cctx working-set|workset|ws
  cctx repomap [N]
  cctx recall <query>
  cctx retain
  cctx remember [--kind KIND] <text>
  cctx forget <match> [--exact] [--id ID] [--yes]
  cctx memory audit|prune [--quality-below N]|recall|remember|forget <query>
  cctx metrics|stats|usage [--json]
  cctx savings [--json] [--global]
  cctx heavy [N]
  cctx bloat
  cctx statusline
  cctx compact [--name NAME]
  cctx diff
  cctx file <path>
  cctx notes [add TEXT]
  cctx backup [list]
  cctx prune [--days N] [--yes]
  cctx purge --yes
  cctx config
  cctx version
  cctx hook <event>
  cctx install-hooks [--dry-run]
  cctx uninstall-hooks
  cctx install-plugin [--dry-run]
  cctx install-all [--dry-run]
  cctx plugin-fix
  cctx setup
  cctx doctor [--deep]
  cctx watch [--interval SEC]
  cctx daemon [--interval SEC]
  cctx serve
`);
}

function runHistory(args, config) {
  const n = Number(args[0] || config?.snapshot?.history_limit || 40);
  const sessions = groupBySession(loadHistory(n)).slice(0, 10);
  if (!sessions.length) {
    console.log('no Codex history found at ' + HISTORY_PATH);
    return 0;
  }
  for (const s of sessions) {
    console.log(`${s.session_id} prompts=${s.items.length} last=${new Date(s.last_ts * 1000).toISOString()}`);
    for (const item of s.items.slice(-3)) console.log(`  - ${item.text.replace(/\s+/g, ' ').slice(0, 180)}`);
  }
  return 0;
}

function runSnapshot(args, config) {
  let name = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) { name = args[i + 1]; i++; }
  }
  const result = writeSnapshot(process.cwd(), config, { name });
  if (!result) {
    console.error('no Codex history found at ' + HISTORY_PATH);
    return 1;
  }
  console.log('snapshot written: ' + result.outPath);
  return 0;
}

function runAsk(args, config) {
  const since = argValue(args, '--since', null);
  const query = stripFlags(args.filter((arg, i) => arg !== '--since' && args[i - 1] !== '--since'), ['--json']).join(' ').trim();
  if (!query) {
    console.error('usage: cctx ask <query> [--since 1w|30m|2h|2026-05-08]');
    return 1;
  }
  console.log(advanced.buildAsk(process.cwd(), query, config, { json: args.includes('--json'), since }));
  return 0;
}

function runStatus(config) {
  console.log(statusText(process.cwd(), config));
  const rows = loadHistory(config?.snapshot?.history_limit || 80);
  const metric = detectLevel(estimateTokens(rows.map(r => r.text).join('\n'), config), config);
  if (metric.level === 'compact' || metric.level === 'urgent' || metric.level === 'critical') {
    console.log('\nrecommendation: create a snapshot, then start fresh with the relevant memory from cctx ask.');
  }
  return 0;
}

function argValue(args, name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

function stripFlags(args, flags) {
  const remove = new Set(flags);
  return args.filter(a => !remove.has(a));
}

function stripOption(args, name) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function runMetrics(args, config) {
  const data = advanced.buildMetrics(process.cwd(), config);
  if (args.includes('--json')) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(`prompts: ${data.prompts}`);
    console.log(`sessions: ${data.sessions}`);
    console.log(`active_days: ${data.active_days}`);
    console.log(`estimated_tokens: ${data.estimated_tokens}/${data.quality_ceiling} (${Math.round(data.context_pct * 100)}%)`);
    console.log(`level: ${data.level}`);
    console.log(`snapshots: ${data.snapshots} (${advanced.fmtBytes(data.snapshot_bytes)})`);
    console.log(`cache: ${data.cache_files} (${advanced.fmtBytes(data.cache_bytes)})`);
  }
  return 0;
}

function runCompact(args, config) {
  const code = runSnapshot(args, config);
  if (code) return code;
  console.log('');
  console.log('Next-session prompt:');
  console.log('Use cctx ask "<topic>" to recall the relevant snapshot, then continue from that context.');
  return 0;
}

function runPrune(args, config) {
  const days = Number(argValue(args, '--days', config?.prune?.older_than_days || 30));
  const dryRun = !args.includes('--yes');
  const result = advanced.prune(process.cwd(), config, { days, dryRun });
  console.log(`${dryRun ? 'would remove' : 'removed'} ${dryRun ? result.matched : result.removed} files older than ${result.days} days (${advanced.fmtBytes(result.bytes)})`);
  if (dryRun) console.log('pass --yes to delete matched cache/snapshot files');
  for (const file of result.files.slice(0, 20)) console.log('  ' + file);
  if (result.files.length > 20) console.log(`  ... ${result.files.length - 20} more`);
  return 0;
}

function runBackup(args, config) {
  if (args[0] === 'list') {
    const items = advanced.listBackups(process.cwd());
    if (!items.length) console.log('no backups');
    for (const item of items) console.log(`${advanced.fmtBytes(item.size).padStart(9)}  ${new Date(item.mtime).toISOString()}  ${item.path}`);
    return 0;
  }
  const result = advanced.backupHistory(process.cwd(), config, { snapshot: args.includes('--snapshot') });
  if (!result) {
    console.error('no Codex history found at ' + HISTORY_PATH);
    return 1;
  }
  console.log(`backup written: ${result.outPath} (${advanced.fmtBytes(result.bytes)})`);
  return 0;
}

function runNotes(args) {
  if (args[0] === 'add') {
    const text = args.slice(1).join(' ').trim();
    if (!text) {
      console.error('usage: cctx notes add <text>');
      return 1;
    }
    console.log('note written: ' + advanced.writeNote(process.cwd(), text));
    return 0;
  }
  console.log(advanced.readNotes(process.cwd()));
  return 0;
}

function runRemember(args, config) {
  const kind = argValue(args, '--kind', 'note');
  const text = args.filter((arg, i) => arg !== '--kind' && args[i - 1] !== '--kind').join(' ').trim();
  if (!text) {
    console.error('usage: cctx remember [--kind KIND] <text>');
    return 1;
  }
  const result = memory.rememberFact(process.cwd(), text, config, { kind });
  if (!result.ok) {
    console.error(result.reason || 'failed to remember fact');
    return 1;
  }
  console.log(`remembered: ${result.fact.kind} ${result.fact.id}`);
  console.log(`path: ${result.path}`);
  return 0;
}

function runForget(args, config) {
  const query = stripFlags(stripOption(args, '--id'), ['--yes', '--exact']).join(' ').trim();
  const id = argValue(args, '--id', null);
  const target = id || query;
  if (!target) {
    console.error('usage: cctx forget <match> [--exact] [--id ID] [--yes]');
    return 1;
  }
  const result = memory.forgetFacts(process.cwd(), target, config, { dryRun: !args.includes('--yes'), exact: args.includes('--exact'), id: Boolean(id) });
  console.log(`facts: before=${result.before} after=${result.after} removed=${result.removed} dryRun=${result.dryRun} mode=${result.mode}`);
  for (const f of result.matches || []) console.log(`- ${f.id} ${f.kind} ${f.text}`);
  if (result.dryRun && result.removed) console.log('pass --yes to delete matched facts');
  return 0;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runWatch(args, config) {
  const interval = Math.max(1, Number(argValue(args, '--interval', args[0] || 5))) * 1000;
  process.stdout.write(advanced.buildStatusline(process.cwd(), config) + '\n');
  while (true) {
    await sleep(interval);
    process.stdout.write(advanced.buildStatusline(process.cwd(), loadConfig()) + '\n');
  }
}

function main(argv = process.argv.slice(2)) {
  ensureUserConfig();
  const config = loadConfig();
  const [cmd, ...args] = argv;
  let code = 0;
  switch (cmd || 'status') {
    case 'status': code = runStatus(config); break;
    case 'history':
    case 'recent':
      code = runHistory(args, config);
      break;
    case 'snapshot': code = runSnapshot(args, config); break;
    case 'ask': code = runAsk(args, config); break;
    case 'report':
    case 'analyze':
      console.log(advanced.buildReport(process.cwd(), config));
      break;
    case 'timeline':
      console.log(advanced.buildTimeline(process.cwd(), config, { json: args.includes('--json'), limit: Number(args[0]) || 40 }));
      break;
    case 'events':
      console.log(advanced.buildEvents(process.cwd(), config, { json: args.includes('--json'), limit: Number(args[0]) || 50 }));
      break;
    case 'working-set':
    case 'workset':
    case 'ws':
      console.log(advanced.buildWorkingSet(process.cwd(), config, { limit: Number(args[0]) || 80 }));
      break;
    case 'repomap':
    case 'repo-map':
      console.log(advanced.buildRepoMap(process.cwd(), config, { limit: Number(args[0]) || undefined }));
      break;
    case 'recall':
      console.log(memory.buildRecall(process.cwd(), stripFlags(args, ['--json']).join(' '), config, { json: args.includes('--json') }));
      break;
    case 'remember':
      code = runRemember(args, config);
      break;
    case 'forget':
      code = runForget(args, config);
      break;
    case 'memory': {
      const [sub, ...rest] = args;
      if (sub === 'audit') console.log(memory.auditFacts(process.cwd(), config, { json: rest.includes('--json') }));
      else if (sub === 'prune') {
        const qualityBelow = argValue(rest, '--quality-below', argValue(rest, '--below', null));
        const result = memory.pruneFacts(process.cwd(), config, { dryRun: !rest.includes('--yes'), qualityBelow: qualityBelow == null ? undefined : Number(qualityBelow) });
        console.log(`facts: before=${result.before} after=${result.after} removed=${result.removed} dryRun=${result.dryRun} quality_below=${result.quality_below}`);
      } else if (sub === 'remember') {
        code = runRemember(rest, config);
      } else if (sub === 'forget') {
        code = runForget(rest, config);
      } else {
        console.log(memory.buildRecall(process.cwd(), stripFlags([sub, ...rest].filter(Boolean), ['--json']).join(' '), config, { json: rest.includes('--json') }));
      }
      break;
    }
    case 'retain': {
      const result = memory.retainFacts(process.cwd(), config, { limit: Number(args[0]) || undefined });
      console.log(`facts: extracted=${result.extracted} total=${result.total}`);
      console.log(`path: ${result.path}`);
      break;
    }
    case 'metrics':
    case 'stats':
    case 'usage':
      code = runMetrics(args, config);
      break;
    case 'savings':
    case 'value':
      console.log(advanced.buildSavings(process.cwd(), config, { json: args.includes('--json'), global: args.includes('--global') }));
      break;
    case 'heavy':
      console.log(advanced.buildHeavy(process.cwd(), config, { limit: Number(args[0]) || 20 }));
      break;
    case 'bloat':
      console.log(advanced.buildBloat(process.cwd(), config));
      break;
    case 'statusline':
      console.log(advanced.buildStatusline(process.cwd(), config));
      break;
    case 'compact':
      code = runCompact(args, config);
      break;
    case 'diff':
      console.log(advanced.diffLatestSnapshots(process.cwd(), config));
      break;
    case 'file':
      if (!args[0]) {
        console.error('usage: cctx file <path>');
        code = 1;
      } else {
        console.log(advanced.readProjectFile(args[0], config));
      }
      break;
    case 'notes':
      code = runNotes(args);
      break;
    case 'backup':
      code = runBackup(args, config);
      break;
    case 'prune':
      code = runPrune(args, config);
      break;
    case 'purge':
      if (!args.includes('--yes')) {
        console.error('purge requires --yes');
        code = 1;
      } else {
        code = runPrune(['--days', '0', '--yes'], config);
      }
      break;
    case 'hook':
      hooks.runHookCli(args[0], config).then((exitCode) => {
        if (exitCode) process.exitCode = exitCode;
      });
      return;
    case 'install-hooks': {
      const result = hooksInstall.installHooks({ dryRun: args.includes('--dry-run') });
      console.log(`${result.dryRun ? 'would install' : 'installed'} hooks: ${result.hooksPath}`);
      console.log(`${result.changedConfig ? 'updated' : 'checked'} feature flag: ${result.configPath}`);
      if (result.hooksBackup) console.log(`backup: ${result.hooksBackup}`);
      break;
    }
    case 'install-plugin': {
      const result = hooksInstall.installPlugin({ dryRun: args.includes('--dry-run') });
      console.log(`${result.dryRun ? 'would enable' : 'enabled'} plugin: ${result.pluginKey}`);
      console.log(`marketplace: ${result.marketplaceName} -> ${result.marketplaceRoot}`);
      if (result.configBackup) console.log(`backup: ${result.configBackup}`);
      break;
    }
    case 'install-all': {
      const result = hooksInstall.installAll({ dryRun: args.includes('--dry-run') });
      console.log(`${result.plugin.dryRun ? 'would enable' : 'enabled'} plugin: ${result.plugin.pluginKey}`);
      console.log(`${result.hooks.dryRun ? 'would install' : 'installed'} hooks: ${result.hooks.hooksPath}`);
      break;
    }
    case 'uninstall-hooks':
      console.log('uninstall-hooks is not destructive by default; edit ~/.codex/hooks.json or reinstall with cctx install-hooks.');
      break;
    case 'plugin-fix':
    case 'setup': {
      const result = hooksInstall.installAll({ dryRun: false });
      console.log(`enabled plugin: ${result.plugin.pluginKey}`);
      console.log(`installed hooks: ${result.hooks.hooksPath}`);
      break;
    }
    case 'upgrade':
      console.log('local source install; update the codex-ctx directory, then run cctx setup.');
      break;
    case 'doctor': {
      const result = args.includes('--deep') ? hooksInstall.doctorDeep(process.cwd(), config) : hooksInstall.doctor();
      console.log(`config: ${result.configPath}`);
      console.log(`hooks: ${result.hooksPath}`);
      console.log(`codex_hooks: ${result.featureEnabled ? 'enabled' : 'missing'}`);
      console.log(`cctx hooks: ${result.hooksInstalled ? 'installed' : 'missing'}`);
      console.log(`marketplace: ${result.marketplaceInstalled ? 'installed' : 'missing'}`);
      console.log(`plugin: ${result.pluginEnabled ? 'enabled' : 'missing'}`);
      console.log(`mcp: ${result.mcpInstalled ? 'installed' : 'missing'}`);
      console.log(`session_start_seen: ${result.sessionStartSeen ? 'yes' : 'no'}`);
      if (result.deep) {
        for (const [name, check] of Object.entries(result.deep)) {
          console.log(`deep.${name}: ${check.ok ? 'ok' : 'fail'}${check.detail !== undefined ? ` (${check.detail})` : ''}`);
        }
      }
      break;
    }
    case 'config':
      console.log('config: ' + USER_PATH);
      console.log('memory: ' + memoryDirFor(process.cwd(), config));
      break;
    case 'version':
      console.log(`${pkg.name} ${pkg.version}`);
      break;
    case 'watch':
    case 'daemon':
      runWatch(args, config).catch((err) => {
        console.error(err && err.message ? err.message : String(err));
        process.exitCode = 1;
      });
      return;
    case 'serve':
      makeServer(allTools(), config).listen();
      break;
    case '--help':
    case '-h':
    case 'help':
      help();
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      help();
      code = 1;
  }
  if (code) process.exitCode = code;
}

module.exports = {
  main,
};
