const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readNonEmptyLines(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map(item => item.trim())
    .filter(Boolean);
}

function writeSessionEvents(codexHome, lines) {
  const sessionPath = path.join(codexHome, 'sessions', '2026', '02', '28', 'session.jsonl');
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, `${lines.join('\n')}\n`, 'utf8');
}

test('maps Stop hooks to task_complete instead of repeated agent_message events', t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crs-bridge-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const codexHome = path.join(tempRoot, 'codex-home');
  const pluginRoot = path.join(codexHome, 'plugins', 'claude-home', 'demo-stop-plugin');
  fs.mkdirSync(pluginRoot, { recursive: true });

  writeJson(path.join(codexHome, 'plugins', 'claude-bridge', 'manifest.json'), {
    version: 1,
    projectRoot: null,
    plugins: [
      {
        id: 'home:demo-stop-plugin',
        sourceType: 'home',
        name: 'demo-stop-plugin',
        rootPath: pluginRoot,
        hookConfigPath: path.join(pluginRoot, 'hooks', 'hooks.json'),
        events: [
          {
            eventName: 'Stop',
            matcher: null,
            commands: [
              {
                command: 'echo stop >> "$CLAUDE_PLUGIN_ROOT/stop.log"',
                timeout: 10
              }
            ]
          },
          {
            eventName: 'TaskComplete',
            matcher: null,
            commands: [
              {
                command: 'echo complete >> "$CLAUDE_PLUGIN_ROOT/task-complete.log"',
                timeout: 10
              }
            ]
          }
        ]
      }
    ],
    topHooks: []
  });

  writeSessionEvents(codexHome, [
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-02-28T10:00:00.000Z',
      payload: { type: 'task_started' }
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-02-28T10:00:01.000Z',
      payload: { type: 'agent_message' }
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-02-28T10:00:02.000Z',
      payload: { type: 'agent_message' }
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-02-28T10:00:03.000Z',
      payload: { type: 'task_complete' }
    })
  ]);

  const bridgeScript = path.join(__dirname, '..', 'src', 'codex-plugin-bridge.js');
  const result = spawnSync(
    process.execPath,
    [bridgeScript, `--codex-home=${codexHome}`, '--verbose', '--no-debug-log'],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const stopLines = readNonEmptyLines(path.join(pluginRoot, 'stop.log'));
  const taskCompleteLines = readNonEmptyLines(path.join(pluginRoot, 'task-complete.log'));

  assert.equal(stopLines.length, 1, `Stop hook should run once, got ${stopLines.length}`);
  assert.equal(taskCompleteLines.length, 1, `TaskComplete hook should run once, got ${taskCompleteLines.length}`);
});
