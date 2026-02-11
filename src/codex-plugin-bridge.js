#!/usr/bin/env node

/**
 * Codex Plugin Bridge
 *
 * 读取 ~/.codex/plugins/claude-bridge/manifest.json，
 * 将 Codex 事件映射为 Claude hooks 事件并执行 command hook。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BRIDGE_MANIFEST_RELATIVE_PATH = path.join('plugins', 'claude-bridge', 'manifest.json');

const CODEX_EVENT_MAP = {
  exec_approval_request: ['PermissionRequest'],
  apply_patch_approval_request: ['PermissionRequest'],
  request_user_input: ['PermissionRequest'],
  task_started: ['TaskStarted'],
  session_configured: ['TaskStarted'],
  task_complete: ['TaskComplete'],
  error: ['ToolError'],
  warning: ['ToolError'],
  turn_aborted: ['ToolError'],
  stream_error: ['ToolError'],
  mcp_startup_complete: ['MCPStartupComplete']
};

function parseArgs(argv) {
  const options = {
    codexHome: null,
    projectRoot: null,
    since: null,
    watch: false,
    pollMs: 600,
    emitStop: false,
    quiet: true
  };

  for (const arg of argv) {
    if (arg === '--watch') {
      options.watch = true;
      continue;
    }

    if (arg === '--emit-stop') {
      options.emitStop = true;
      continue;
    }

    if (arg === '--verbose') {
      options.quiet = false;
      continue;
    }

    if (arg.startsWith('--codex-home=')) {
      options.codexHome = path.resolve(arg.slice('--codex-home='.length));
      continue;
    }

    if (arg.startsWith('--project-root=')) {
      options.projectRoot = path.resolve(arg.slice('--project-root='.length));
      continue;
    }

    if (arg.startsWith('--since=')) {
      const raw = Number(arg.slice('--since='.length));
      if (Number.isFinite(raw) && raw > 0) {
        options.since = raw;
      }
      continue;
    }

    if (arg.startsWith('--poll-ms=')) {
      const raw = Number(arg.slice('--poll-ms='.length));
      if (Number.isFinite(raw) && raw >= 200) {
        options.pollMs = raw;
      }
      continue;
    }

    throw new Error(`未知参数: ${arg}`);
  }

  return options;
}

function resolveCodexHome(overrideValue) {
  if (overrideValue) {
    return overrideValue;
  }

  if (process.env.CODEX_HOME && process.env.CODEX_HOME.trim()) {
    return path.resolve(process.env.CODEX_HOME);
  }

  return path.join(os.homedir(), '.codex');
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${filePath} JSON 解析失败: ${error.message}`);
  }
}

function readManifest(codexHome) {
  const manifestPath = path.join(codexHome, BRIDGE_MANIFEST_RELATIVE_PATH);
  const manifest = readJsonIfExists(manifestPath);
  if (!manifest || typeof manifest !== 'object') {
    return {
      manifestPath,
      plugins: [],
      topHooks: []
    };
  }

  return {
    manifestPath,
    plugins: Array.isArray(manifest.plugins) ? manifest.plugins : [],
    topHooks: Array.isArray(manifest.topHooks) ? manifest.topHooks : []
  };
}

function collectSessionFiles(sessionsRoot, sinceEpochSec) {
  if (!fs.existsSync(sessionsRoot)) {
    return [];
  }

  const files = [];
  const stack = [sessionsRoot];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }

      if (sinceEpochSec) {
        const stat = fs.statSync(fullPath);
        const modifiedSec = Math.floor(stat.mtimeMs / 1000);
        if (modifiedSec < sinceEpochSec) {
          continue;
        }
      }

      files.push(fullPath);
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function parseCodexEvent(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (_) {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  if (parsed.type !== 'event_msg') {
    return null;
  }

  const payload = parsed.payload;
  if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') {
    return null;
  }

  return {
    rawType: payload.type,
    payload
  };
}

function mapEventNames(rawType) {
  const mapped = CODEX_EVENT_MAP[rawType] || [];
  return [...mapped, rawType];
}

function buildMatcherText(eventRecord) {
  const payload = eventRecord.payload || {};

  const parts = [eventRecord.rawType];
  if (Array.isArray(payload.command)) {
    parts.push(payload.command.join(' '));
  }

  if (typeof payload.reason === 'string') {
    parts.push(payload.reason);
  }

  if (typeof payload.call_id === 'string') {
    parts.push(payload.call_id);
  }

  return parts.join(' ');
}

function matchesRule(matcher, text) {
  if (!matcher) {
    return true;
  }

  try {
    return new RegExp(matcher).test(text);
  } catch (_) {
    return false;
  }
}

function safeStringValue(value) {
  if (value == null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return JSON.stringify(value);
}

function runHookCommand({ command, timeoutSec, contextEnv, quiet }) {
  const result = spawnSync('bash', ['-lc', command], {
    env: {
      ...process.env,
      ...contextEnv
    },
    stdio: quiet ? 'ignore' : 'inherit',
    timeout: Math.max(1, timeoutSec) * 1000
  });

  return result.status === 0;
}

function getAllHookSources(manifest) {
  return [...manifest.plugins, ...manifest.topHooks];
}

function executeEvent(manifest, eventRecord, projectRoot, quiet) {
  const names = mapEventNames(eventRecord.rawType);
  const matcherText = buildMatcherText(eventRecord);
  const sources = getAllHookSources(manifest);

  for (const source of sources) {
    const events = Array.isArray(source.events) ? source.events : [];

    for (const eventDef of events) {
      if (!eventDef || typeof eventDef.eventName !== 'string') {
        continue;
      }

      if (!names.includes(eventDef.eventName)) {
        continue;
      }

      if (!matchesRule(eventDef.matcher, matcherText)) {
        continue;
      }

      const commands = Array.isArray(eventDef.commands) ? eventDef.commands : [];
      for (const commandDef of commands) {
        if (!commandDef || typeof commandDef.command !== 'string' || !commandDef.command.trim()) {
          continue;
        }

        const timeout = Number.isFinite(commandDef.timeout) ? Number(commandDef.timeout) : 10;
        runHookCommand({
          command: commandDef.command,
          timeoutSec: timeout,
          quiet,
          contextEnv: {
            CLAUDE_PLUGIN_ROOT: source.rootPath || '',
            CLAUDE_PROJECT_ROOT: projectRoot || '',
            CRS_EVENT_TYPE: names[0],
            CRS_EVENT_RAW_TYPE: eventRecord.rawType,
            CRS_EVENT_MATCHER_TEXT: matcherText,
            CRS_EVENT_REASON: safeStringValue(eventRecord.payload.reason),
            CRS_CALL_ID: safeStringValue(eventRecord.payload.call_id)
          }
        });
      }
    }
  }
}

function processSessionFile(filePath, state, manifest, projectRoot, quiet) {
  let currentOffset = state.offsets.get(filePath) || 0;
  let remainder = state.remainders.get(filePath) || '';

  const stat = fs.statSync(filePath);
  if (stat.size < currentOffset) {
    currentOffset = 0;
    remainder = '';
  }

  if (stat.size === currentOffset) {
    return;
  }

  const fd = fs.openSync(filePath, 'r');
  const chunkSize = stat.size - currentOffset;
  const buffer = Buffer.alloc(chunkSize);
  fs.readSync(fd, buffer, 0, chunkSize, currentOffset);
  fs.closeSync(fd);

  const text = `${remainder}${buffer.toString('utf8')}`;
  const lines = text.split('\n');
  remainder = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    const eventRecord = parseCodexEvent(line);
    if (!eventRecord) {
      continue;
    }

    executeEvent(manifest, eventRecord, projectRoot, quiet);
  }

  state.offsets.set(filePath, stat.size);
  state.remainders.set(filePath, remainder);
}

function runOnce(options) {
  const codexHome = resolveCodexHome(options.codexHome);
  const manifest = readManifest(codexHome);
  const sessionsRoot = path.join(codexHome, 'sessions');
  const files = collectSessionFiles(sessionsRoot, options.since);

  const state = {
    offsets: new Map(),
    remainders: new Map()
  };

  for (const filePath of files) {
    processSessionFile(filePath, state, manifest, options.projectRoot, options.quiet);
  }

  if (options.emitStop) {
    executeEvent(manifest, { rawType: 'Stop', payload: {} }, options.projectRoot, options.quiet);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function watch(options) {
  const codexHome = resolveCodexHome(options.codexHome);
  const manifest = readManifest(codexHome);
  const sessionsRoot = path.join(codexHome, 'sessions');

  const state = {
    offsets: new Map(),
    remainders: new Map()
  };

  let stopping = false;
  const requestStop = () => {
    stopping = true;
  };

  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);

  while (!stopping) {
    const files = collectSessionFiles(sessionsRoot, options.since);
    for (const filePath of files) {
      if (stopping) {
        break;
      }
      processSessionFile(filePath, state, manifest, options.projectRoot, options.quiet);
    }

    await sleep(options.pollMs);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.watch) {
    await watch(options);
    return;
  }

  runOnce(options);
}

main().catch(error => {
  console.error(`codex-plugin-bridge 运行失败: ${error.message}`);
  process.exit(1);
});
