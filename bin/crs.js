#!/usr/bin/env node

const { spawnSync } = require('child_process');
const path = require('path');

function printHelp() {
  console.log(`claude-runtime-sync CLI

Usage:
  crs sync [flags]              Sync Claude source-of-truth into Codex
  crs check [flags]             Check drift only (exit code 1 when drift exists)
  crs bridge [flags]            Run Codex plugin bridge
  crs hook install [zshrc]      Install zsh codex auto-sync hook
  crs hook remove [zshrc]       Remove zsh codex auto-sync hook
  crs sync-base [flags]         Run base sync (skills+mcp)
  crs --help

Common flags:
  --codex-home=PATH
  --claude-home=PATH
  --project-root=PATH
  --no-home
  --no-project
`);
}

function runNodeScript(scriptPath, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: 'inherit',
    env: process.env
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === 'number') {
    process.exit(result.status);
  }

  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
  printHelp();
  process.exit(0);
}

const command = argv[0];
const rest = argv.slice(1);

const srcRoot = path.join(__dirname, '..', 'src');
const runtimeSyncScript = path.join(srcRoot, 'claude-runtime-sync.js');
const bridgeScript = path.join(srcRoot, 'codex-plugin-bridge.js');
const hookScript = path.join(srcRoot, 'install-codex-zsh-hook.js');
const baseSyncScript = path.join(srcRoot, 'sync-claude-all-to-codex.js');

if (command === 'sync') {
  runNodeScript(runtimeSyncScript, rest);
}

if (command === 'check') {
  runNodeScript(runtimeSyncScript, ['--check', ...rest]);
}

if (command === 'bridge') {
  runNodeScript(bridgeScript, rest);
}

if (command === 'sync-base') {
  runNodeScript(baseSyncScript, rest);
}

if (command === 'hook') {
  const mode = rest[0];
  if (mode !== 'install' && mode !== 'remove') {
    console.error('hook 子命令仅支持 install/remove');
    process.exit(1);
  }

  runNodeScript(hookScript, rest);
}

console.error(`未知命令: ${command}`);
printHelp();
process.exit(1);
