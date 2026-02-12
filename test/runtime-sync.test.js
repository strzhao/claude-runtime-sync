const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { syncRuntimeSources } = require('../src/claude-runtime-sync');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
}

function createPlugin(rootPath, pluginName, options = {}) {
  writeJson(path.join(rootPath, '.claude-plugin', 'plugin.json'), {
    name: pluginName,
    version: '1.0.0',
    description: `${pluginName} test plugin`
  });

  if (options.skills) {
    for (const [skillName, content] of Object.entries(options.skills)) {
      writeText(path.join(rootPath, 'skills', skillName, 'SKILL.md'), content);
    }
  }

  if (options.mcp) {
    writeJson(path.join(rootPath, '.mcp.json'), {
      mcpServers: options.mcp
    });
  }

  if (options.hooks) {
    writeJson(path.join(rootPath, 'hooks', 'hooks.json'), options.hooks);
  }
}

test('syncs enabled plugin capabilities from registry with expected precedence', t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crs-registry-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const claudeHome = path.join(tempRoot, 'claude-home');
  const codexHome = path.join(tempRoot, 'codex-home');
  const projectRoot = path.join(tempRoot, 'project-a');
  fs.mkdirSync(projectRoot, { recursive: true });

  const homePluginRoot = path.join(
    claudeHome,
    'plugins',
    'cache',
    'example-market',
    'home-plugin',
    '1.0.0'
  );
  const projectPluginRoot = path.join(
    claudeHome,
    'plugins',
    'cache',
    'example-market',
    'project-plugin',
    '1.0.0'
  );

  createPlugin(homePluginRoot, 'home-plugin', {
    skills: {
      'home-skill': '# Home Skill\n'
    },
    mcp: {
      'shared-server': { command: 'plugin-command' },
      'plugin-only-server': { command: 'plugin-only-command' }
    },
    hooks: {
      hooks: {
        TaskComplete: [
          {
            hooks: [
              {
                type: 'command',
                command: 'echo done'
              }
            ]
          }
        ]
      }
    }
  });

  createPlugin(projectPluginRoot, 'project-plugin', {
    skills: {
      'project-skill': '# Project Skill\n'
    },
    mcp: {
      'project-plugin-server': { command: 'project-plugin-command' }
    }
  });

  writeJson(path.join(claudeHome, 'plugins', 'enabled_plugins_shared.json'), {
    'home-plugin@example-market': true,
    'project-plugin@example-market': true,
    'ignored-local@example-market': true
  });

  writeJson(path.join(claudeHome, 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: {
      'home-plugin@example-market': [
        {
          scope: 'user',
          installPath: homePluginRoot,
          installedAt: '2026-02-01T00:00:00.000Z',
          lastUpdated: '2026-02-10T00:00:00.000Z'
        }
      ],
      'project-plugin@example-market': [
        {
          scope: 'local',
          projectPath: projectRoot,
          installPath: projectPluginRoot,
          installedAt: '2026-02-01T00:00:00.000Z',
          lastUpdated: '2026-02-10T00:00:00.000Z'
        }
      ],
      'ignored-local@example-market': [
        {
          scope: 'local',
          projectPath: path.join(tempRoot, 'other-project'),
          installPath: path.join(tempRoot, 'missing-plugin')
        }
      ]
    }
  });

  writeJson(path.join(claudeHome, 'mcp.json'), {
    mcpServers: {
      'shared-server': { command: 'home-command' }
    }
  });

  writeJson(path.join(projectRoot, '.mcp.json'), {
    mcpServers: {
      'shared-server': { command: 'project-command' }
    }
  });

  const report = syncRuntimeSources({
    projectRoot,
    claudeHome,
    codexHome,
    check: false,
    includeHome: true,
    includeProject: true
  });

  const pluginReportBySource = new Map(report.pluginReports.map(item => [item.source, item]));
  assert.equal(pluginReportBySource.get('home').sourceCount, 1);
  assert.equal(pluginReportBySource.get('project').sourceCount, 1);

  const homeEntry = pluginReportBySource.get('home').entries[0];
  const projectEntry = pluginReportBySource.get('project').entries[0];

  assert.ok(fs.existsSync(path.join(codexHome, 'skills', 'claude-home', 'plugins', homeEntry.targetName, 'home-skill', 'SKILL.md')));
  assert.ok(
    fs.existsSync(
      path.join(
        codexHome,
        'skills',
        'project',
        path.basename(projectRoot),
        'plugins',
        projectEntry.targetName,
        'project-skill',
        'SKILL.md'
      )
    )
  );

  const mcpConfig = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  assert.match(mcpConfig, /\[mcp_servers\.shared-server\][\s\S]*?command = "project-command"/);
  assert.match(mcpConfig, /command = "plugin-only-command"/);
  assert.match(mcpConfig, /command = "project-plugin-command"/);
  assert.ok(!/\[mcp_servers\.shared-server\][\s\S]*?command = "plugin-command"/.test(mcpConfig));

  const manifest = JSON.parse(fs.readFileSync(path.join(codexHome, 'plugins', 'claude-bridge', 'manifest.json'), 'utf8'));
  assert.ok(manifest.plugins.some(plugin => plugin.name === 'home-plugin'));
});

test('falls back to legacy plugin directory scan when registry files are absent', t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crs-legacy-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const claudeHome = path.join(tempRoot, 'claude-home');
  const codexHome = path.join(tempRoot, 'codex-home');
  const projectRoot = path.join(tempRoot, 'project-b');
  fs.mkdirSync(projectRoot, { recursive: true });

  const legacyPluginRoot = path.join(claudeHome, 'plugins', 'legacy-plugin');
  createPlugin(legacyPluginRoot, 'legacy-plugin', {
    skills: {
      'legacy-skill': '# Legacy Skill\n'
    },
    mcp: {
      'legacy-plugin-server': { command: 'legacy-plugin-command' }
    }
  });

  writeJson(path.join(claudeHome, 'mcp.json'), {
    mcpServers: {}
  });

  const report = syncRuntimeSources({
    projectRoot,
    claudeHome,
    codexHome,
    check: false,
    includeHome: true,
    includeProject: false
  });

  const homePluginReport = report.pluginReports.find(item => item.source === 'home');
  assert.equal(homePluginReport.sourceCount, 1);

  const legacyEntry = homePluginReport.entries[0];
  assert.ok(fs.existsSync(path.join(codexHome, 'plugins', 'claude-home', legacyEntry.targetName, '.claude-plugin', 'plugin.json')));
  assert.ok(fs.existsSync(path.join(codexHome, 'skills', 'claude-home', 'plugins', legacyEntry.targetName, 'legacy-skill', 'SKILL.md')));

  const mcpConfig = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  assert.match(mcpConfig, /legacy-plugin-command/);
});
