#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const mode = process.argv[2] || 'install';
const zshrcArg = process.argv[3];

if (!['install', 'remove'].includes(mode)) {
  console.error('Usage: node scripts/install-codex-zsh-hook.js [install|remove] [zshrc_path]');
  process.exit(1);
}

function resolveCodexHome() {
  if (process.env.CODEX_HOME && process.env.CODEX_HOME.trim()) {
    return path.resolve(process.env.CODEX_HOME);
  }

  return path.join(os.homedir(), '.codex');
}

function expandPath(inputPath) {
  if (!inputPath) {
    return path.join(os.homedir(), '.zshrc');
  }

  if (inputPath === '~') {
    return os.homedir();
  }

  if (inputPath.startsWith('~/')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return path.resolve(inputPath);
}

function readText(filePath) {
  if (!fs.existsSync(filePath)) {
    return '';
  }

  return fs.readFileSync(filePath, 'utf8');
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function findManagedBlock(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) {
    return null;
  }

  const endStart = text.indexOf(endMarker, start);
  if (endStart === -1) {
    return null;
  }

  let end = endStart + endMarker.length;
  if (text[end] === '\n') {
    end += 1;
  }

  return { start, end };
}

function copyScript(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`未找到脚本: ${sourcePath}`);
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  fs.chmodSync(targetPath, 0o755);
}

function installHelpers(codexHome) {
  const syncSourcePath = path.join(__dirname, 'claude-runtime-sync.js');
  const baseSyncSourcePath = path.join(__dirname, 'sync-claude-all-to-codex.js');
  const bridgeSourcePath = path.join(__dirname, 'codex-plugin-bridge.js');

  const syncTargetPath = path.join(codexHome, 'scripts', 'sync-claude-to-codex.js');
  const baseSyncTargetPath = path.join(codexHome, 'scripts', 'sync-claude-all-to-codex.js');
  const bridgeTargetPath = path.join(codexHome, 'scripts', 'codex-plugin-bridge.js');

  copyScript(syncSourcePath, syncTargetPath);
  copyScript(baseSyncSourcePath, baseSyncTargetPath);
  copyScript(bridgeSourcePath, bridgeTargetPath);

  return {
    syncTargetPath,
    baseSyncTargetPath,
    bridgeTargetPath
  };
}

const codexHome = resolveCodexHome();
const zshrcPath = expandPath(zshrcArg);
const startMarker = '# >>> codex-claude-sync >>>';
const endMarker = '# <<< codex-claude-sync <<<';

const block = [
  '# >>> codex-claude-sync >>>',
  '# Auto-sync ~/.claude (+ project .claude) into Codex before launching Codex.',
  '# Set CODEX_SYNC_DISABLE=1 to temporarily skip sync.',
  '# Set CODEX_PLUGIN_BRIDGE_DISABLE=1 to temporarily disable plugin hooks bridge.',
  'codex() {',
  '  local first_arg="${1-}"',
  '  local codex_home',
  '  local sync_script',
  '  local bridge_script',
  '  local bridge_pid=""',
  '  local bridge_since=""',
  '',
  '  case "$first_arg" in',
  '    -h|--help|-V|--version|completion|login|logout|features)',
  '      command codex "$@"',
  '      return $?',
  '      ;;',
  '  esac',
  '',
  '  codex_home="${CODEX_HOME:-$HOME/.codex}"',
  '  sync_script="$codex_home/scripts/sync-claude-to-codex.js"',
  '  bridge_script="$codex_home/scripts/codex-plugin-bridge.js"',
  '',
  '  if [[ "${CODEX_SYNC_DISABLE:-0}" != "1" ]]; then',
  '    if command -v node >/dev/null 2>&1 && [[ -f "$sync_script" ]]; then',
  '      node "$sync_script" --check >/dev/null 2>&1 || node "$sync_script" >/dev/null 2>&1',
  '    fi',
  '  fi',
  '',
  '  if [[ "${CODEX_PLUGIN_BRIDGE_DISABLE:-0}" != "1" ]]; then',
  '    if command -v node >/dev/null 2>&1 && [[ -f "$bridge_script" ]]; then',
  '      bridge_since="$(date +%s)"',
  '      node "$bridge_script" --watch --since="$bridge_since" --codex-home="$codex_home" --project-root="$PWD" >/dev/null 2>&1 &',
  '      bridge_pid="$!"',
  '    fi',
  '  fi',
  '',
  '  command codex "$@"',
  '  local codex_rc=$?',
  '',
  '  if [[ -n "$bridge_pid" ]]; then',
  '    node "$bridge_script" --emit-stop --codex-home="$codex_home" --project-root="$PWD" >/dev/null 2>&1 || true',
  '    kill "$bridge_pid" >/dev/null 2>&1 || true',
  '    wait "$bridge_pid" >/dev/null 2>&1 || true',
  '  fi',
  '',
  '  return $codex_rc',
  '}',
  '# <<< codex-claude-sync <<<'
].join('\n');

const currentText = readText(zshrcPath);

if (mode === 'install') {
  const helperPaths = installHelpers(codexHome);
  const existing = findManagedBlock(currentText, startMarker, endMarker);
  let newText;

  if (existing) {
    const before = currentText.slice(0, existing.start).replace(/\s*$/, '');
    const after = currentText.slice(existing.end).replace(/^\s*/, '');
    const parts = [before, block, after].filter(Boolean);
    newText = `${parts.join('\n\n')}\n`;
  } else if (currentText.trim()) {
    newText = `${currentText.replace(/\s*$/, '')}\n\n${block}\n`;
  } else {
    newText = `${block}\n`;
  }

  writeText(zshrcPath, newText);
  console.log(`Installed Codex sync helper to ${helperPaths.syncTargetPath}`);
  console.log(`Installed Codex base sync helper to ${helperPaths.baseSyncTargetPath}`);
  console.log(`Installed Codex plugin bridge helper to ${helperPaths.bridgeTargetPath}`);
  console.log(`Installed Codex sync hook in ${zshrcPath}`);
  process.exit(0);
}

const existing = findManagedBlock(currentText, startMarker, endMarker);
if (!existing) {
  console.log(`No hook block found in ${zshrcPath}`);
  process.exit(0);
}

const before = currentText.slice(0, existing.start).replace(/\s*$/, '');
const after = currentText.slice(existing.end).replace(/^\s*/, '');
const parts = [before, after].filter(Boolean);
const newText = parts.length > 0 ? `${parts.join('\n\n')}\n` : '';

writeText(zshrcPath, newText);
console.log(`Removed Codex sync hook from ${zshrcPath}`);
