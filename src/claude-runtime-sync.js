#!/usr/bin/env node

/**
 * Claude Runtime Sync
 *
 * 让 ~/.claude 与 <repo>/.claude 作为唯一真实源，复用到 Codex：
 * - skills + mcp（委托现有 sync-claude-all-to-codex）
 * - plugins + hooks
 * - CLAUDE.md -> agents.md / gemini.md
 * - 生成插件桥接 manifest（供 codex-plugin-bridge 使用）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const { syncSources: syncBaseSources } = require('./sync-claude-all-to-codex');

const BRIDGE_MANIFEST_RELATIVE_PATH = path.join('plugins', 'claude-bridge', 'manifest.json');

const DEFAULT_OPTIONS = {
  ignorePlugins: [],
  ignoreHookSources: [],
  pluginNameMap: {}
};

function parseArgs(argv) {
  const options = {
    check: false,
    codexHome: null,
    claudeHome: null,
    projectRoot: null,
    noHome: false,
    noProject: false
  };

  for (const arg of argv) {
    if (arg === '--check') {
      options.check = true;
      continue;
    }

    if (arg === '--no-home') {
      options.noHome = true;
      continue;
    }

    if (arg === '--no-project') {
      options.noProject = true;
      continue;
    }

    if (arg.startsWith('--codex-home=')) {
      options.codexHome = path.resolve(arg.slice('--codex-home='.length));
      continue;
    }

    if (arg.startsWith('--claude-home=')) {
      options.claudeHome = path.resolve(arg.slice('--claude-home='.length));
      continue;
    }

    if (arg.startsWith('--project-root=')) {
      options.projectRoot = path.resolve(arg.slice('--project-root='.length));
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

function resolveClaudeHome(overrideValue) {
  if (overrideValue) {
    return overrideValue;
  }

  return path.join(os.homedir(), '.claude');
}

function detectProjectRoot(explicitRoot) {
  if (explicitRoot) {
    return explicitRoot;
  }

  try {
    const output = execSync('git rev-parse --show-toplevel', {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return output.toString('utf8').trim();
  } catch (_) {
    return null;
  }
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

function normalizeOptions(userOptions, configPath) {
  const merged = {
    ...DEFAULT_OPTIONS,
    ...(userOptions || {})
  };

  for (const key of ['ignorePlugins', 'ignoreHookSources']) {
    if (!Array.isArray(merged[key])) {
      throw new Error(`${configPath} 中 ${key} 必须是数组`);
    }
  }

  if (!merged.pluginNameMap || typeof merged.pluginNameMap !== 'object' || Array.isArray(merged.pluginNameMap)) {
    throw new Error(`${configPath} 中 pluginNameMap 必须是对象`);
  }

  return merged;
}

function loadSyncOptions(configPath) {
  const userOptions = readJsonIfExists(configPath);
  if (!userOptions) {
    return { ...DEFAULT_OPTIONS };
  }

  return normalizeOptions(userOptions, configPath);
}

function listDirectories(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function listFilesRecursive(rootDir, currentDir = rootDir) {
  if (!fs.existsSync(currentDir)) {
    return [];
  }

  const files = [];
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, absolutePath);

    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(rootDir, absolutePath));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (entry.name === '.DS_Store') {
      continue;
    }

    files.push(relativePath);
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function digestDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return null;
  }

  const hash = crypto.createHash('sha256');
  const files = listFilesRecursive(dirPath);

  for (const relativePath of files) {
    const absolutePath = path.join(dirPath, relativePath);
    hash.update(relativePath);
    hash.update('\0');
    hash.update(fs.readFileSync(absolutePath));
    hash.update('\0');
  }

  return hash.digest('hex');
}

function digestFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) => a.localeCompare(b));
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

function sanitizePathSegment(value, fallback) {
  const cleaned = String(value || '').replace(/[\\/]/g, '-').trim();
  return cleaned || fallback;
}

function resolveUniqueName(baseName, usedNames) {
  if (!usedNames.has(baseName)) {
    usedNames.add(baseName);
    return baseName;
  }

  let index = 2;
  while (usedNames.has(`${baseName}-${index}`)) {
    index += 1;
  }

  const finalName = `${baseName}-${index}`;
  usedNames.add(finalName);
  return finalName;
}

function buildPluginMappings(sourcePluginsDir, options) {
  const ignoreSet = new Set(options.ignorePlugins || []);
  const sourceDirs = listDirectories(sourcePluginsDir);
  const warnings = [];
  const mappings = [];
  const usedTargets = new Set();

  for (const sourceName of sourceDirs) {
    if (ignoreSet.has(sourceName)) {
      continue;
    }

    const sourcePath = path.join(sourcePluginsDir, sourceName);
    const metaPath = path.join(sourcePath, '.claude-plugin', 'plugin.json');
    if (!fs.existsSync(metaPath)) {
      warnings.push(`插件目录 ${sourceName} 缺少 .claude-plugin/plugin.json，已跳过`);
      continue;
    }

    let pluginName = sourceName;
    try {
      const meta = readJsonIfExists(metaPath);
      if (meta && typeof meta.name === 'string' && meta.name.trim()) {
        pluginName = meta.name.trim();
      }
    } catch (error) {
      warnings.push(`插件目录 ${sourceName} 元数据解析失败，已跳过: ${error.message}`);
      continue;
    }

    const mappedName = options.pluginNameMap[pluginName] || options.pluginNameMap[sourceName] || pluginName;
    const normalizedTarget = sanitizePathSegment(mappedName, sourceName);
    const targetName = resolveUniqueName(normalizedTarget, usedTargets);

    mappings.push({
      sourceName,
      sourcePath,
      pluginName,
      targetName
    });
  }

  return { mappings, warnings };
}

function syncPlugins({ sourcePluginsDir, targetPluginsRoot, sourceType, options, check }) {
  const { mappings, warnings } = buildPluginMappings(sourcePluginsDir, options);
  const targetNames = new Set(mappings.map(item => item.targetName));
  const existingTargetDirs = listDirectories(targetPluginsRoot);

  const added = [];
  const updated = [];
  const removed = [];
  const entries = [];

  for (const mapping of mappings) {
    const targetPath = path.join(targetPluginsRoot, mapping.targetName);
    entries.push({
      sourceType,
      pluginName: mapping.pluginName,
      sourcePath: mapping.sourcePath,
      targetPath
    });

    if (!fs.existsSync(targetPath)) {
      added.push(mapping.targetName);
      if (!check) {
        fs.mkdirSync(targetPluginsRoot, { recursive: true });
        fs.cpSync(mapping.sourcePath, targetPath, { recursive: true, force: true });
      }
      continue;
    }

    const sourceDigest = digestDirectory(mapping.sourcePath);
    const targetDigest = digestDirectory(targetPath);
    if (sourceDigest !== targetDigest) {
      updated.push(mapping.targetName);
      if (!check) {
        fs.rmSync(targetPath, { recursive: true, force: true });
        fs.cpSync(mapping.sourcePath, targetPath, { recursive: true, force: true });
      }
    }
  }

  for (const existingDir of existingTargetDirs) {
    if (targetNames.has(existingDir)) {
      continue;
    }

    removed.push(existingDir);
    if (!check) {
      fs.rmSync(path.join(targetPluginsRoot, existingDir), { recursive: true, force: true });
    }
  }

  const changed = added.length > 0 || updated.length > 0 || removed.length > 0;
  return {
    changed,
    sourceCount: mappings.length,
    targetRoot: targetPluginsRoot,
    added: added.sort((a, b) => a.localeCompare(b)),
    updated: updated.sort((a, b) => a.localeCompare(b)),
    removed: removed.sort((a, b) => a.localeCompare(b)),
    warnings,
    entries
  };
}

function syncHooksDir({ sourceHooksDir, targetHooksRoot, sourceType, options, check }) {
  const warnings = [];
  if ((options.ignoreHookSources || []).includes(sourceType)) {
    return {
      enabled: false,
      changed: false,
      sourcePath: sourceHooksDir,
      targetRoot: targetHooksRoot,
      added: [],
      updated: [],
      removed: [],
      warnings,
      hookFilePath: null,
      sourceType
    };
  }

  const hookFileName = 'hooks.json';
  const sourceHookPath = path.join(sourceHooksDir, hookFileName);
  const targetHookPath = path.join(targetHooksRoot, hookFileName);
  const targetExists = fs.existsSync(targetHookPath);
  const sourceExists = fs.existsSync(sourceHookPath);

  const added = [];
  const updated = [];
  const removed = [];

  if (!sourceExists) {
    if (targetExists) {
      removed.push(hookFileName);
      if (!check) {
        fs.rmSync(targetHookPath, { force: true });
      }
    }

    return {
      enabled: false,
      changed: removed.length > 0,
      sourcePath: sourceHookPath,
      targetRoot: targetHooksRoot,
      added,
      updated,
      removed,
      warnings,
      hookFilePath: null,
      sourceType
    };
  }

  if (!targetExists) {
    added.push(hookFileName);
    if (!check) {
      fs.mkdirSync(targetHooksRoot, { recursive: true });
      fs.copyFileSync(sourceHookPath, targetHookPath);
    }
  } else {
    const sourceDigest = digestFile(sourceHookPath);
    const targetDigest = digestFile(targetHookPath);
    if (sourceDigest !== targetDigest) {
      updated.push(hookFileName);
      if (!check) {
        fs.mkdirSync(targetHooksRoot, { recursive: true });
        fs.copyFileSync(sourceHookPath, targetHookPath);
      }
    }
  }

  return {
    enabled: true,
    changed: added.length > 0 || updated.length > 0 || removed.length > 0,
    sourcePath: sourceHookPath,
    targetRoot: targetHooksRoot,
    added,
    updated,
    removed,
    warnings,
    hookFilePath: targetHookPath,
    sourceType
  };
}

function safeReadlinkTarget(linkPath) {
  try {
    const rawTarget = fs.readlinkSync(linkPath);
    return path.resolve(path.dirname(linkPath), rawTarget);
  } catch (_) {
    return null;
  }
}

function syncDocAliases({ projectRoot, check }) {
  const sourceCandidates = ['CLAUDE.md', 'claude.md'];
  const targetAliases = ['agents.md', 'gemini.md'];
  const warnings = [];
  const linked = [];
  const copied = [];
  const unchanged = [];

  let sourcePath = null;
  for (const candidate of sourceCandidates) {
    const fullPath = path.join(projectRoot, candidate);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      sourcePath = fullPath;
      break;
    }
  }

  if (!sourcePath) {
    return {
      enabled: false,
      changed: false,
      sourcePath: null,
      linked,
      copied,
      unchanged,
      warnings: ['项目中未找到 CLAUDE.md/claude.md，跳过文档别名同步']
    };
  }

  const sourceContent = fs.readFileSync(sourcePath, 'utf8');
  const sourceBaseName = path.basename(sourcePath);

  for (const aliasName of targetAliases) {
    const aliasPath = path.join(projectRoot, aliasName);

    if (fs.existsSync(aliasPath)) {
      const stat = fs.lstatSync(aliasPath);
      if (stat.isSymbolicLink()) {
        const resolved = safeReadlinkTarget(aliasPath);
        if (resolved === sourcePath) {
          unchanged.push(aliasName);
          continue;
        }
      } else if (stat.isFile()) {
        const targetContent = fs.readFileSync(aliasPath, 'utf8');
        if (targetContent === sourceContent) {
          unchanged.push(aliasName);
          continue;
        }
      }

      if (!check) {
        fs.rmSync(aliasPath, { force: true });
      }
    }

    if (check) {
      linked.push(aliasName);
      continue;
    }

    try {
      fs.symlinkSync(sourceBaseName, aliasPath);
      linked.push(aliasName);
    } catch (error) {
      fs.copyFileSync(sourcePath, aliasPath);
      copied.push(aliasName);
      warnings.push(`创建软链接失败，已回退复制 ${aliasName}: ${error.message}`);
    }
  }

  return {
    enabled: true,
    changed: linked.length > 0 || copied.length > 0,
    sourcePath,
    linked,
    copied,
    unchanged,
    warnings
  };
}

function parseHookDefinitions(hookConfigPath, warnings) {
  const hookConfig = readJsonIfExists(hookConfigPath);
  if (!hookConfig || typeof hookConfig !== 'object') {
    return [];
  }

  const hooksObject = hookConfig.hooks;
  if (!hooksObject || typeof hooksObject !== 'object' || Array.isArray(hooksObject)) {
    warnings.push(`${hookConfigPath} 缺少 hooks 对象，已跳过`);
    return [];
  }

  const eventSpecs = [];
  for (const [eventName, eventRules] of Object.entries(hooksObject)) {
    if (!Array.isArray(eventRules)) {
      warnings.push(`${hookConfigPath} 的事件 ${eventName} 不是数组，已跳过`);
      continue;
    }

    for (const eventRule of eventRules) {
      const matcher = typeof eventRule.matcher === 'string' && eventRule.matcher.trim() ? eventRule.matcher.trim() : null;
      const hooks = Array.isArray(eventRule.hooks) ? eventRule.hooks : [];
      const commands = [];

      for (const hook of hooks) {
        if (!hook || hook.type !== 'command' || typeof hook.command !== 'string' || !hook.command.trim()) {
          continue;
        }

        let timeout = 10;
        if (typeof hook.timeout === 'number' && Number.isFinite(hook.timeout) && hook.timeout > 0) {
          timeout = hook.timeout;
        }

        commands.push({
          command: hook.command,
          timeout
        });
      }

      if (commands.length === 0) {
        continue;
      }

      eventSpecs.push({
        eventName,
        matcher,
        commands
      });
    }
  }

  return eventSpecs;
}

function buildBridgeManifest({ codexHome, check, pluginReports, hookReports, projectRoot }) {
  const warnings = [];
  const pluginByName = new Map();
  const sourcePriority = { project: 2, home: 1 };

  const allPluginEntries = pluginReports.flatMap(item => item.entries || []);
  allPluginEntries.sort((a, b) => {
    const pa = sourcePriority[a.sourceType] || 0;
    const pb = sourcePriority[b.sourceType] || 0;
    return pb - pa;
  });

  for (const entry of allPluginEntries) {
    if (pluginByName.has(entry.pluginName)) {
      continue;
    }

    const hookConfigPath = path.join(entry.targetPath, 'hooks', 'hooks.json');
    if (!fs.existsSync(hookConfigPath)) {
      continue;
    }

    const events = parseHookDefinitions(hookConfigPath, warnings);
    if (events.length === 0) {
      continue;
    }

    pluginByName.set(entry.pluginName, {
      id: `${entry.sourceType}:${entry.pluginName}`,
      sourceType: entry.sourceType,
      name: entry.pluginName,
      rootPath: entry.targetPath,
      hookConfigPath,
      events
    });
  }

  const topHookSources = [];
  for (const report of hookReports) {
    if (!report.enabled || !report.hookFilePath || !fs.existsSync(report.hookFilePath)) {
      continue;
    }

    const events = parseHookDefinitions(report.hookFilePath, warnings);
    if (events.length === 0) {
      continue;
    }

    topHookSources.push({
      id: `${report.sourceType}:top-hooks`,
      sourceType: report.sourceType,
      name: `${report.sourceType}-hooks`,
      rootPath: path.dirname(report.hookFilePath),
      hookConfigPath: report.hookFilePath,
      events
    });
  }

  const contentPayload = {
    version: 1,
    projectRoot: projectRoot || null,
    plugins: [...pluginByName.values()],
    topHooks: topHookSources
  };

  const manifestPath = path.join(codexHome, BRIDGE_MANIFEST_RELATIVE_PATH);
  const oldManifest = readJsonIfExists(manifestPath);
  const oldContentPayload = oldManifest && typeof oldManifest === 'object'
    ? {
      version: oldManifest.version || 1,
      projectRoot: Object.prototype.hasOwnProperty.call(oldManifest, 'projectRoot') ? oldManifest.projectRoot : null,
      plugins: Array.isArray(oldManifest.plugins) ? oldManifest.plugins : [],
      topHooks: Array.isArray(oldManifest.topHooks) ? oldManifest.topHooks : []
    }
    : null;

  const changed = !oldContentPayload || stableStringify(oldContentPayload) !== stableStringify(contentPayload);

  const manifest = {
    ...contentPayload,
    generatedAt: changed
      ? new Date().toISOString()
      : (oldManifest && oldManifest.generatedAt ? oldManifest.generatedAt : new Date().toISOString())
  };

  if (changed && !check) {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  return {
    changed,
    manifestPath,
    pluginCount: manifest.plugins.length,
    topHookCount: manifest.topHooks.length,
    warnings
  };
}

function syncRuntimeSources({ projectRoot, claudeHome, codexHome, check, includeHome, includeProject }) {
  const baseReport = syncBaseSources({
    projectRoot,
    claudeHome,
    codexHome,
    check,
    includeHome,
    includeProject
  });

  const homeOptions = loadSyncOptions(path.join(claudeHome, '.codex-sync.json'));
  const projectOptions = projectRoot
    ? loadSyncOptions(path.join(projectRoot, '.claude-codex-sync.json'))
    : { ...DEFAULT_OPTIONS };

  const pluginReports = [];
  const hookReports = [];
  const warnings = [...(baseReport.warnings || [])];

  if (includeHome) {
    const homePlugins = syncPlugins({
      sourcePluginsDir: path.join(claudeHome, 'plugins'),
      targetPluginsRoot: path.join(codexHome, 'plugins', 'claude-home'),
      sourceType: 'home',
      options: homeOptions,
      check
    });
    pluginReports.push({ source: 'home', ...homePlugins });
    warnings.push(...homePlugins.warnings);

    const homeHooks = syncHooksDir({
      sourceHooksDir: path.join(claudeHome, 'hooks'),
      targetHooksRoot: path.join(codexHome, 'hooks', 'claude-home'),
      sourceType: 'home',
      options: homeOptions,
      check
    });
    hookReports.push(homeHooks);
    warnings.push(...homeHooks.warnings);
  }

  if (includeProject && projectRoot) {
    const projectPlugins = syncPlugins({
      sourcePluginsDir: path.join(projectRoot, '.claude', 'plugins'),
      targetPluginsRoot: path.join(codexHome, 'plugins', 'project', path.basename(projectRoot)),
      sourceType: 'project',
      options: projectOptions,
      check
    });
    pluginReports.push({ source: 'project', ...projectPlugins });
    warnings.push(...projectPlugins.warnings);

    const projectHooks = syncHooksDir({
      sourceHooksDir: path.join(projectRoot, '.claude', 'hooks'),
      targetHooksRoot: path.join(codexHome, 'hooks', 'project', path.basename(projectRoot)),
      sourceType: 'project',
      options: projectOptions,
      check
    });
    hookReports.push(projectHooks);
    warnings.push(...projectHooks.warnings);
  }

  const docAliases = projectRoot && includeProject
    ? syncDocAliases({ projectRoot, check })
    : {
      enabled: false,
      changed: false,
      sourcePath: null,
      linked: [],
      copied: [],
      unchanged: [],
      warnings: []
    };
  warnings.push(...docAliases.warnings);

  const bridgeManifest = buildBridgeManifest({
    codexHome,
    check,
    pluginReports,
    hookReports,
    projectRoot
  });
  warnings.push(...bridgeManifest.warnings);

  const pluginsChanged = pluginReports.some(item => item.changed);
  const hooksChanged = hookReports.some(item => item.changed);

  return {
    changed: Boolean(baseReport.changed || pluginsChanged || hooksChanged || docAliases.changed || bridgeManifest.changed),
    check,
    claudeHome,
    codexHome,
    projectRoot,
    includeHome,
    includeProject,
    baseReport,
    pluginReports,
    hookReports,
    docAliases,
    bridgeManifest,
    warnings
  };
}

function printReport(report) {
  const modeText = report.check ? '检查模式（不写入）' : '同步模式（会写入）';
  console.log(`\n🔄 Claude Runtime -> Codex：${modeText}`);
  console.log(`🏠 Claude Home: ${report.claudeHome}`);
  console.log(`🏠 Codex Home: ${report.codexHome}`);
  console.log(`📁 Project Root: ${report.projectRoot || '无（仅全局）'}`);

  const base = report.baseReport;
  console.log('\n🧩 Skills:');
  for (const item of base.skillsReports || []) {
    console.log(`- [${item.source}] 来源数量: ${item.sourceCount}`);
    console.log(`  目标目录: ${item.targetRoot}`);
    console.log(`  新增: ${item.added.length > 0 ? item.added.join(', ') : '无'}`);
    console.log(`  更新: ${item.updated.length > 0 ? item.updated.join(', ') : '无'}`);
    console.log(`  删除: ${item.removed.length > 0 ? item.removed.join(', ') : '无'}`);
  }

  console.log('\n🔌 Plugins:');
  if (report.pluginReports.length === 0) {
    console.log('- 本次未启用 plugins 同步');
  }
  for (const item of report.pluginReports) {
    console.log(`- [${item.source}] 来源数量: ${item.sourceCount}`);
    console.log(`  目标目录: ${item.targetRoot}`);
    console.log(`  新增: ${item.added.length > 0 ? item.added.join(', ') : '无'}`);
    console.log(`  更新: ${item.updated.length > 0 ? item.updated.join(', ') : '无'}`);
    console.log(`  删除: ${item.removed.length > 0 ? item.removed.join(', ') : '无'}`);
  }

  console.log('\n🪝 Hooks:');
  if (report.hookReports.length === 0) {
    console.log('- 本次未启用 hooks 同步');
  }
  for (const item of report.hookReports) {
    console.log(`- [${item.sourceType}] 目标目录: ${item.targetRoot}`);
    console.log(`  新增: ${item.added.length > 0 ? item.added.join(', ') : '无'}`);
    console.log(`  更新: ${item.updated.length > 0 ? item.updated.join(', ') : '无'}`);
    console.log(`  删除: ${item.removed.length > 0 ? item.removed.join(', ') : '无'}`);
  }

  console.log('\n📄 CLAUDE.md 别名:');
  if (!report.docAliases.enabled) {
    console.log('- 未启用或缺少 CLAUDE.md，已跳过');
  } else {
    console.log(`- 来源: ${report.docAliases.sourcePath}`);
    console.log(`- 链接: ${report.docAliases.linked.length > 0 ? report.docAliases.linked.join(', ') : '无'}`);
    console.log(`- 复制回退: ${report.docAliases.copied.length > 0 ? report.docAliases.copied.join(', ') : '无'}`);
    console.log(`- 已一致: ${report.docAliases.unchanged.length > 0 ? report.docAliases.unchanged.join(', ') : '无'}`);
  }

  console.log('\n🔗 MCP:');
  if (base.mcp && base.mcp.skipped) {
    console.log('- 未发现可用 mcp 源文件，本次跳过 mcp 同步');
  } else if (base.mcp) {
    console.log(`- 来源配置: ${base.mcp.sourcePaths.join(' | ')}`);
    console.log(`- 目标配置: ${base.mcp.configPath}`);
    console.log(`- 托管 server 数量: ${base.mcp.managedCount}`);
    console.log(`- 新增: ${base.mcp.added.length > 0 ? base.mcp.added.join(', ') : '无'}`);
    console.log(`- 更新: ${base.mcp.updated.length > 0 ? base.mcp.updated.join(', ') : '无'}`);
    console.log(`- 删除: ${base.mcp.removed.length > 0 ? base.mcp.removed.join(', ') : '无'}`);
  }

  console.log('\n🧠 Plugin Bridge Manifest:');
  console.log(`- 文件: ${report.bridgeManifest.manifestPath}`);
  console.log(`- 激活插件数: ${report.bridgeManifest.pluginCount}`);
  console.log(`- 顶层 hooks 数: ${report.bridgeManifest.topHookCount}`);

  const warningSet = [...new Set(report.warnings || [])];
  if (warningSet.length > 0) {
    console.log('\n⚠️ Warnings:');
    for (const warning of warningSet) {
      console.log(`- ${warning}`);
    }
  }

  if (report.changed) {
    console.log(report.check ? '\n❗ 检测到差异，需要执行同步。' : '\n✅ 同步完成，已写入变更。');
  } else {
    console.log('\n✅ 已是最新，无需同步。');
  }
}

function main() {
  const cliOptions = parseArgs(process.argv.slice(2));
  const codexHome = resolveCodexHome(cliOptions.codexHome);
  const claudeHome = resolveClaudeHome(cliOptions.claudeHome);
  const projectRoot = detectProjectRoot(cliOptions.projectRoot);

  const includeHome = !cliOptions.noHome;
  const includeProject = !cliOptions.noProject && Boolean(projectRoot);

  const report = syncRuntimeSources({
    projectRoot,
    claudeHome,
    codexHome,
    check: cliOptions.check,
    includeHome,
    includeProject
  });

  printReport(report);

  if (cliOptions.check && report.changed) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`\n❌ 同步失败: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  BRIDGE_MANIFEST_RELATIVE_PATH,
  buildBridgeManifest,
  parseHookDefinitions,
  syncDocAliases,
  syncHooksDir,
  syncPlugins,
  syncRuntimeSources
};
