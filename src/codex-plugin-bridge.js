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
const DEFAULT_DEBUG_LOG_RELATIVE_PATH = path.join('log', 'plugin-bridge.log');
const WATCH_LOCK_RELATIVE_PATH = path.join('plugins', 'claude-bridge', 'watch.lock');
const RECENT_EVENT_TTL_MS = 30_000;
const RECENT_EVENT_MAX = 2000;
const WATCH_CLEANUP_LOG_TAIL_BYTES = 32 * 1024 * 1024;
const WATCH_CLEANUP_ACTIVITY_WINDOW_MS = 6 * 60 * 60 * 1000;

const CODEX_EVENT_MAP = {
  exec_approval_request: ['PermissionRequest'],
  apply_patch_approval_request: ['PermissionRequest'],
  request_user_input: ['PermissionRequest'],
  task_started: ['TaskStarted'],
  session_configured: ['TaskStarted'],
  // Codex may emit many agent_message events within a single task.
  // Map Stop to task_complete so Claude-style Stop hooks run once per task.
  task_complete: ['TaskComplete', 'Stop'],
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
    quiet: true,
    debugLog: true,
    debugLogPath: null
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

    if (arg === '--debug-log') {
      options.debugLog = true;
      continue;
    }

    if (arg === '--no-debug-log') {
      options.debugLog = false;
      continue;
    }

    if (arg.startsWith('--debug-log=')) {
      options.debugLog = true;
      options.debugLogPath = path.resolve(arg.slice('--debug-log='.length));
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

function parseEventTimestampSec(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  if (typeof parsed.timestamp !== 'string' || !parsed.timestamp.trim()) {
    return null;
  }

  const ms = Date.parse(parsed.timestamp);
  if (!Number.isFinite(ms)) {
    return null;
  }

  return Math.floor(ms / 1000);
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

  if (parsed.type === 'event_msg') {
    const payload = parsed.payload;
    if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') {
      return null;
    }

    return {
      rawType: payload.type,
      payload,
      eventTimestampSec: parseEventTimestampSec(parsed)
    };
  }

  if (parsed.type === 'response_item') {
    const payload = parsed.payload;
    if (!payload || typeof payload !== 'object' || payload.type !== 'function_call') {
      return null;
    }

    const toolName = typeof payload.name === 'string' ? payload.name : '';
    if (!toolName) {
      return null;
    }

    let toolArgs;
    try {
      toolArgs = JSON.parse(payload.arguments || '{}');
    } catch (_) {
      return null;
    }

    if (!toolArgs || typeof toolArgs !== 'object') {
      return null;
    }

    // PermissionRequest is represented as a function_call that asks for escalation.
    if (toolArgs.sandbox_permissions !== 'require_escalated') {
      return null;
    }

    const rawType = toolName === 'apply_patch' ? 'apply_patch_approval_request' : 'exec_approval_request';
    return {
      rawType,
      payload: {
        ...toolArgs,
        tool_name: toolName,
        call_id: typeof payload.call_id === 'string' ? payload.call_id : ''
      },
      eventTimestampSec: parseEventTimestampSec(parsed)
    };
  }

  return null;
}

function mapEventNames(rawType) {
  const mapped = CODEX_EVENT_MAP[rawType] || [];
  return [...mapped, rawType];
}

function buildMatcherText(eventRecord) {
  const payload = eventRecord.payload || {};

  const parts = [eventRecord.rawType];
  if (typeof payload.tool_name === 'string') {
    parts.push(payload.tool_name);
  }

  if (Array.isArray(payload.command)) {
    parts.push(payload.command.join(' '));
  } else if (typeof payload.command === 'string') {
    parts.push(payload.command);
  }

  if (typeof payload.reason === 'string') {
    parts.push(payload.reason);
  }

  if (typeof payload.justification === 'string') {
    parts.push(payload.justification);
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

function resolveDebugLogPath(options, codexHome) {
  if (!options.debugLog) {
    return null;
  }

  if (options.debugLogPath) {
    return options.debugLogPath;
  }

  if (process.env.CODEX_PLUGIN_BRIDGE_DEBUG_LOG_PATH && process.env.CODEX_PLUGIN_BRIDGE_DEBUG_LOG_PATH.trim()) {
    return path.resolve(process.env.CODEX_PLUGIN_BRIDGE_DEBUG_LOG_PATH);
  }

  return path.join(codexHome, DEFAULT_DEBUG_LOG_RELATIVE_PATH);
}

function createDebugLogger(logFilePath) {
  if (!logFilePath) {
    return () => {};
  }

  return (kind, data = {}) => {
    try {
      fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
      const payload = {
        ts: new Date().toISOString(),
        pid: process.pid,
        kind,
        ...data
      };

      fs.appendFileSync(logFilePath, `${JSON.stringify(payload)}\n`, 'utf8');
    } catch (_) {
      // Ignore logging failures to avoid impacting bridge behavior.
    }
  };
}

function readTailText(filePath, maxBytes) {
  if (!fs.existsSync(filePath)) {
    return '';
  }

  const stat = fs.statSync(filePath);
  if (stat.size <= 0) {
    return '';
  }

  const readBytes = Math.max(0, Math.min(maxBytes, stat.size));
  if (readBytes <= 0) {
    return '';
  }

  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(readBytes);
    fs.readSync(fd, buffer, 0, readBytes, stat.size - readBytes);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function parseLogTimestampMs(rawValue) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return null;
  }

  const ts = Date.parse(rawValue);
  return Number.isFinite(ts) ? ts : null;
}

function cleanupCompetingWatchers(codexHome, projectRoot, logDebug, debugLogPath) {
  if (!debugLogPath) {
    return;
  }

  const tailText = readTailText(debugLogPath, WATCH_CLEANUP_LOG_TAIL_BYTES);
  if (!tailText.trim()) {
    logDebug('watch-cleanup-scan', {
      status: 'empty-log',
      codexHome,
      projectRoot: projectRoot || ''
    });
    return;
  }

  const lines = tailText.split('\n');
  const pidState = new Map();
  let parsedLineCount = 0;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    let record;
    try {
      record = JSON.parse(line);
    } catch (_) {
      continue;
    }
    parsedLineCount += 1;

    const pid = Number(record.pid);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
      continue;
    }

    const tsMs = parseLogTimestampMs(record.ts) || 0;
    let state = pidState.get(pid);
    if (!state) {
      state = {
        lastTsMs: 0,
        isWatch: false,
        isStopped: false,
        codexHome: '',
        projectRoot: ''
      };
      pidState.set(pid, state);
    }

    if (tsMs > state.lastTsMs) {
      state.lastTsMs = tsMs;
    }

    if (record.kind === 'bridge-start' && record.mode === 'watch') {
      state.isWatch = true;
      state.isStopped = false;
      state.codexHome = typeof record.codexHome === 'string' ? record.codexHome : '';
      state.projectRoot = typeof record.projectRoot === 'string' ? record.projectRoot : '';
      continue;
    }

    if (record.kind === 'bridge-stop' && record.mode === 'watch') {
      state.isStopped = true;
      continue;
    }
  }

  const nowMs = Date.now();
  let candidateCount = 0;
  let killedCount = 0;
  for (const [pid, state] of pidState.entries()) {
    if (!state.isWatch || state.isStopped) {
      continue;
    }

    if (state.codexHome !== codexHome || state.projectRoot !== (projectRoot || '')) {
      continue;
    }

    if ((nowMs - state.lastTsMs) > WATCH_CLEANUP_ACTIVITY_WINDOW_MS) {
      continue;
    }
    candidateCount += 1;

    try {
      process.kill(pid, 'SIGTERM');
      killedCount += 1;
      logDebug('watch-cleanup-terminated', {
        targetPid: pid,
        targetProjectRoot: state.projectRoot,
        targetCodexHome: state.codexHome
      });
    } catch (error) {
      logDebug('watch-cleanup-skip', {
        targetPid: pid,
        error: error && error.message ? error.message : String(error || '')
      });
    }
  }

  logDebug('watch-cleanup-scan', {
    status: 'completed',
    codexHome,
    projectRoot: projectRoot || '',
    parsedLineCount,
    trackedPidCount: pidState.size,
    candidateCount,
    killedCount
  });
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function parseWatchLockPid(rawText) {
  if (!rawText || !rawText.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawText);
    return Number.isInteger(parsed.pid) ? parsed.pid : null;
  } catch (_) {
    const numeric = Number(rawText.trim());
    return Number.isInteger(numeric) ? numeric : null;
  }
}

function acquireWatchLock(codexHome, logDebug) {
  const lockPath = path.join(codexHome, WATCH_LOCK_RELATIVE_PATH);
  const payload = JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString()
  });

  const writeLock = () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, payload, 'utf8');
    fs.closeSync(fd);
  };

  try {
    writeLock();
  } catch (error) {
    if (!error || error.code !== 'EEXIST') {
      throw error;
    }

    let existingPid = null;
    let stale = true;
    try {
      const existingRaw = fs.readFileSync(lockPath, 'utf8');
      existingPid = parseWatchLockPid(existingRaw);
      stale = !isProcessAlive(existingPid);
    } catch (_) {
      stale = true;
    }

    if (!stale) {
      logDebug('watch-lock-busy', { lockPath, existingPid });
      return null;
    }

    try {
      fs.unlinkSync(lockPath);
      writeLock();
      logDebug('watch-lock-recovered', { lockPath, existingPid });
    } catch (_) {
      logDebug('watch-lock-busy', { lockPath, existingPid });
      return null;
    }
  }

  logDebug('watch-lock-acquired', { lockPath });

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;

    try {
      const existingRaw = fs.readFileSync(lockPath, 'utf8');
      const existingPid = parseWatchLockPid(existingRaw);
      if (existingPid === process.pid) {
        fs.unlinkSync(lockPath);
      }
    } catch (_) {
      // Ignore lock cleanup errors.
    }

    logDebug('watch-lock-released', { lockPath });
  };
}

function runHookCommand({ command, timeoutSec, contextEnv, quiet }) {
  const startedAt = Date.now();
  let result;

  try {
    result = spawnSync('bash', ['-lc', command], {
      env: {
        ...process.env,
        ...contextEnv
      },
      stdio: quiet ? 'ignore' : 'inherit',
      timeout: Math.max(1, timeoutSec) * 1000
    });
  } catch (error) {
    return {
      ok: false,
      status: null,
      signal: '',
      error: error.message,
      timedOut: false,
      durationMs: Date.now() - startedAt
    };
  }

  return {
    ok: result.status === 0,
    status: Number.isInteger(result.status) ? result.status : null,
    signal: typeof result.signal === 'string' ? result.signal : '',
    error: result.error ? result.error.message : '',
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    durationMs: Date.now() - startedAt
  };
}

function getAllHookSources(manifest) {
  return [...manifest.plugins, ...manifest.topHooks];
}

function executeEvent(manifest, eventRecord, projectRoot, quiet, logDebug) {
  const names = mapEventNames(eventRecord.rawType);
  const matcherText = buildMatcherText(eventRecord);
  const sources = getAllHookSources(manifest);
  const hasSpecialMapping = Array.isArray(CODEX_EVENT_MAP[eventRecord.rawType]) && CODEX_EVENT_MAP[eventRecord.rawType].length > 0;
  let executedCommandCount = 0;

  if (hasSpecialMapping || eventRecord.rawType === 'Stop') {
    logDebug('event-received', {
      rawType: eventRecord.rawType,
      mappedTypes: names,
      matcherText
    });
  }

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
        executedCommandCount += 1;

        logDebug('hook-command-start', {
          sourceId: source.id || '',
          sourceName: source.name || '',
          eventName: eventDef.eventName,
          matcher: eventDef.matcher || '',
          timeoutSec: timeout,
          command: commandDef.command
        });

        const hookResult = runHookCommand({
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

        logDebug('hook-command-finish', {
          sourceId: source.id || '',
          sourceName: source.name || '',
          eventName: eventDef.eventName,
          command: commandDef.command,
          ok: hookResult.ok,
          status: hookResult.status,
          signal: hookResult.signal,
          timedOut: hookResult.timedOut,
          durationMs: hookResult.durationMs,
          error: hookResult.error
        });
      }
    }
  }

  if ((hasSpecialMapping || eventRecord.rawType === 'Stop') && executedCommandCount === 0) {
    logDebug('event-no-hook-executed', {
      rawType: eventRecord.rawType,
      mappedTypes: names,
      matcherText
    });
  }
}

function primeSessionOffsets(files, state) {
  for (const filePath of files) {
    if (state.offsets.has(filePath)) {
      continue;
    }

    // Start from file beginning and rely on timestamp-based since filtering.
    // This avoids missing newly appended events in long-lived session files.
    state.offsets.set(filePath, 0);
    state.remainders.set(filePath, '');
  }
}

function recordAndCheckDuplicateEvent(state, signature) {
  const nowMs = Date.now();
  const recentEvents = state.recentEvents;
  const lastSeenMs = recentEvents.get(signature);
  recentEvents.set(signature, nowMs);

  if (recentEvents.size > RECENT_EVENT_MAX) {
    for (const [key, seenAt] of recentEvents.entries()) {
      if ((nowMs - seenAt) > RECENT_EVENT_TTL_MS || recentEvents.size > RECENT_EVENT_MAX) {
        recentEvents.delete(key);
      } else {
        break;
      }
    }
  }

  return typeof lastSeenMs === 'number' && (nowMs - lastSeenMs) <= RECENT_EVENT_TTL_MS;
}

function processSessionFile(filePath, state, manifest, projectRoot, quiet, logDebug) {
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

    if (
      Number.isFinite(state.sinceEpochSec) &&
      Number(state.sinceEpochSec) > 0 &&
      Number.isFinite(eventRecord.eventTimestampSec) &&
      Number(eventRecord.eventTimestampSec) < Number(state.sinceEpochSec)
    ) {
      continue;
    }

    if (recordAndCheckDuplicateEvent(state, line)) {
      logDebug('event-deduped', {
        rawType: eventRecord.rawType,
        sourceFile: filePath
      });
      continue;
    }

    executeEvent(manifest, eventRecord, projectRoot, quiet, logDebug);
  }

  state.offsets.set(filePath, stat.size);
  state.remainders.set(filePath, remainder);
}

function runOnce(options) {
  const codexHome = resolveCodexHome(options.codexHome);
  const logDebug = createDebugLogger(resolveDebugLogPath(options, codexHome));
  const manifest = readManifest(codexHome);
  const sessionsRoot = path.join(codexHome, 'sessions');
  const files = collectSessionFiles(sessionsRoot, options.since);

  logDebug('bridge-start', {
    mode: 'once',
    codexHome,
    projectRoot: options.projectRoot || '',
    since: options.since,
    watch: false,
    manifestPath: manifest.manifestPath,
    pluginCount: manifest.plugins.length,
    topHookCount: manifest.topHooks.length,
    sessionFileCount: files.length
  });

  const state = {
    offsets: new Map(),
    remainders: new Map(),
    recentEvents: new Map(),
    sinceEpochSec: options.since
  };

  for (const filePath of files) {
    processSessionFile(filePath, state, manifest, options.projectRoot, options.quiet, logDebug);
  }

  if (options.emitStop) {
    executeEvent(manifest, { rawType: 'Stop', payload: {} }, options.projectRoot, options.quiet, logDebug);
  }

  logDebug('bridge-stop', { mode: 'once' });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function watch(options) {
  const codexHome = resolveCodexHome(options.codexHome);
  const debugLogPath = resolveDebugLogPath(options, codexHome);
  const logDebug = createDebugLogger(debugLogPath);
  const manifest = readManifest(codexHome);
  const sessionsRoot = path.join(codexHome, 'sessions');

  logDebug('bridge-start', {
    mode: 'watch',
    codexHome,
    projectRoot: options.projectRoot || '',
    since: options.since,
    watch: true,
    pollMs: options.pollMs,
    manifestPath: manifest.manifestPath,
    pluginCount: manifest.plugins.length,
    topHookCount: manifest.topHooks.length
  });

  const state = {
    offsets: new Map(),
    remainders: new Map(),
    recentEvents: new Map(),
    sinceEpochSec: options.since
  };

  cleanupCompetingWatchers(codexHome, options.projectRoot, logDebug, debugLogPath);

  const releaseWatchLock = acquireWatchLock(codexHome, logDebug);
  if (!releaseWatchLock) {
    return;
  }

  let stopping = false;
  const requestStop = () => {
    stopping = true;
  };

  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);

  const initialFiles = collectSessionFiles(sessionsRoot, options.since);
  primeSessionOffsets(initialFiles, state);
  logDebug('watch-initialized', { trackedFileCount: initialFiles.length });

  try {
    // Always perform one final scan after stop is requested to avoid losing tail events.
    while (true) {
      const files = collectSessionFiles(sessionsRoot, options.since);
      primeSessionOffsets(files, state);
      for (const filePath of files) {
        processSessionFile(filePath, state, manifest, options.projectRoot, options.quiet, logDebug);
      }

      if (stopping) {
        break;
      }

      await sleep(options.pollMs);
    }
  } finally {
    releaseWatchLock();
  }

  logDebug('bridge-stop', { mode: 'watch' });
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
