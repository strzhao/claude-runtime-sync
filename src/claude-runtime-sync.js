#!/usr/bin/env node

/**
 * Claude Runtime Sync
 *
 * 让 ~/.claude 与 <repo>/.claude 作为唯一真实源，复用到 Codex：
 * - skills + mcp（委托现有 sync-claude-all-to-codex）
 * - plugins（hooks + skills + .mcp.json）
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

function parseTimeMs(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return 0;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getPluginKeyName(pluginKey) {
  if (typeof pluginKey !== 'string') {
    return '';
  }

  const atIndex = pluginKey.indexOf('@');
  return atIndex > 0 ? pluginKey.slice(0, atIndex) : pluginKey;
}

function resolveRealPath(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch (_) {
    return path.resolve(filePath);
  }
}

function matchRecordScope(record, sourceType, projectRoot) {
  const scope = typeof record.scope === 'string' ? record.scope.trim().toLowerCase() : '';

  if (sourceType === 'home') {
    return scope === 'user' || scope === 'shared';
  }

  if (sourceType !== 'project') {
    return false;
  }

  if (scope !== 'project' && scope !== 'local') {
    return false;
  }

  if (!projectRoot || typeof record.projectPath !== 'string' || !record.projectPath.trim()) {
    return false;
  }

  return path.resolve(record.projectPath) === path.resolve(projectRoot);
}

function chooseInstallRecord(records, sourceType, projectRoot) {
  const candidates = records
    .filter(item => item && typeof item === 'object')
    .filter(item => typeof item.installPath === 'string' && item.installPath.trim())
    .filter(item => matchRecordScope(item, sourceType, projectRoot))
    .map(item => ({
      ...item,
      installPath: path.resolve(item.installPath)
    }));

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => {
    const aExists = fs.existsSync(a.installPath) ? 1 : 0;
    const bExists = fs.existsSync(b.installPath) ? 1 : 0;
    if (aExists !== bExists) {
      return bExists - aExists;
    }

    const aTime = parseTimeMs(a.lastUpdated || a.installedAt);
    const bTime = parseTimeMs(b.lastUpdated || b.installedAt);
    return bTime - aTime;
  });

  return candidates[0];
}

function readPluginNameFromMetadata(pluginRoot, fallbackName, warnings, sourceLabel) {
  const metaPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(metaPath)) {
    warnings.push(`${sourceLabel} 缺少 .claude-plugin/plugin.json，已跳过`);
    return null;
  }

  try {
    const meta = readJsonIfExists(metaPath);
    if (meta && typeof meta.name === 'string' && meta.name.trim()) {
      return meta.name.trim();
    }

    return fallbackName;
  } catch (error) {
    warnings.push(`${sourceLabel} 元数据解析失败，已跳过: ${error.message}`);
    return null;
  }
}

function collectPluginCandidatesFromRegistry({ sourcePluginsDir, sourceType, projectRoot, warnings }) {
  const enabledPath = path.join(sourcePluginsDir, 'enabled_plugins_shared.json');
  const installedPath = path.join(sourcePluginsDir, 'installed_plugins.json');

  if (!fs.existsSync(enabledPath) || !fs.existsSync(installedPath)) {
    return {
      usable: false,
      candidates: []
    };
  }

  let enabledMap;
  let installedMap;

  try {
    enabledMap = readJsonIfExists(enabledPath) || {};
    installedMap = readJsonIfExists(installedPath) || {};
  } catch (error) {
    warnings.push(`插件索引解析失败，回退目录扫描: ${error.message}`);
    return {
      usable: false,
      candidates: []
    };
  }

  if (!enabledMap || typeof enabledMap !== 'object' || Array.isArray(enabledMap)) {
    warnings.push(`${enabledPath} 结构不合法，回退目录扫描`);
    return {
      usable: false,
      candidates: []
    };
  }

  const installedPlugins = installedMap.plugins;
  if (!installedPlugins || typeof installedPlugins !== 'object' || Array.isArray(installedPlugins)) {
    warnings.push(`${installedPath} 缺少 plugins 对象，回退目录扫描`);
    return {
      usable: false,
      candidates: []
    };
  }

  const candidates = [];
  const enabledKeys = Object.keys(enabledMap)
    .filter(key => Boolean(enabledMap[key]))
    .sort((a, b) => a.localeCompare(b));

  for (const pluginKey of enabledKeys) {
    const records = installedPlugins[pluginKey];
    if (!Array.isArray(records) || records.length === 0) {
      warnings.push(`已启用插件 ${pluginKey} 未在 installed_plugins.json 中找到记录，已跳过`);
      continue;
    }

    const selected = chooseInstallRecord(records, sourceType, projectRoot);
    if (!selected) {
      continue;
    }

    if (!fs.existsSync(selected.installPath)) {
      warnings.push(`插件 ${pluginKey} 安装目录不存在，已跳过: ${selected.installPath}`);
      continue;
    }

    const fallbackName = getPluginKeyName(pluginKey) || pluginKey;
    const pluginName = readPluginNameFromMetadata(
      selected.installPath,
      fallbackName,
      warnings,
      `插件 ${pluginKey}`
    );
    if (!pluginName) {
      continue;
    }

    candidates.push({
      sourceName: pluginKey,
      sourcePath: selected.installPath,
      pluginName,
      pluginKey
    });
  }

  return {
    usable: true,
    candidates
  };
}

function collectPluginCandidatesFromDirectoryScan({ sourcePluginsDir, warnings }) {
  const sourceDirs = listDirectories(sourcePluginsDir);
  const candidates = [];

  for (const sourceName of sourceDirs) {
    const sourcePath = path.join(sourcePluginsDir, sourceName);
    const pluginName = readPluginNameFromMetadata(
      sourcePath,
      sourceName,
      warnings,
      `插件目录 ${sourceName}`
    );
    if (!pluginName) {
      continue;
    }

    candidates.push({
      sourceName,
      sourcePath,
      pluginName,
      pluginKey: null
    });
  }

  return candidates;
}

function finalizePluginMappings(candidates, options) {
  const safeOptions = options && typeof options === 'object' && !Array.isArray(options)
    ? options
    : {};
  const ignoreSet = new Set(Array.isArray(safeOptions.ignorePlugins) ? safeOptions.ignorePlugins : []);
  const pluginNameMap = safeOptions.pluginNameMap && typeof safeOptions.pluginNameMap === 'object' && !Array.isArray(safeOptions.pluginNameMap)
    ? safeOptions.pluginNameMap
    : {};
  const mappings = [];
  const usedTargets = new Set();
  const seenSourcePaths = new Set();

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }

    if (ignoreSet.has(candidate.sourceName) || ignoreSet.has(candidate.pluginName) || (candidate.pluginKey && ignoreSet.has(candidate.pluginKey))) {
      continue;
    }

    const sourcePath = resolveRealPath(candidate.sourcePath);
    if (seenSourcePaths.has(sourcePath)) {
      continue;
    }
    seenSourcePaths.add(sourcePath);

    const mappedName = pluginNameMap[candidate.pluginKey]
      || pluginNameMap[candidate.pluginName]
      || pluginNameMap[candidate.sourceName]
      || candidate.pluginName;
    const normalizedTarget = sanitizePathSegment(mappedName, candidate.sourceName);
    const targetName = resolveUniqueName(normalizedTarget, usedTargets);

    mappings.push({
      sourceName: candidate.sourceName,
      sourcePath,
      pluginName: candidate.pluginName,
      pluginKey: candidate.pluginKey,
      targetName
    });
  }

  return mappings;
}

function buildPluginMappings({
  sourceType,
  options,
  projectRoot,
  registryPluginsDir,
  legacyPluginsDir,
  includeLegacyWhenRegistryAvailable = false
}) {
  const warnings = [];
  const candidates = [];

  let registryUsable = false;
  if (registryPluginsDir) {
    const registryResult = collectPluginCandidatesFromRegistry({
      sourcePluginsDir: registryPluginsDir,
      sourceType,
      projectRoot,
      warnings
    });

    if (registryResult.usable) {
      registryUsable = true;
      candidates.push(...registryResult.candidates);
    }
  }

  const shouldUseLegacyScan = Boolean(legacyPluginsDir)
    && (!registryUsable || includeLegacyWhenRegistryAvailable);
  if (shouldUseLegacyScan) {
    candidates.push(
      ...collectPluginCandidatesFromDirectoryScan({
        sourcePluginsDir: legacyPluginsDir,
        warnings
      })
    );
  }

  return {
    warnings,
    mappings: finalizePluginMappings(candidates, options),
    registryUsable
  };
}

function syncPluginsFromMappings({ mappings, targetPluginsRoot, sourceType, check }) {
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
      pluginKey: mapping.pluginKey,
      sourcePath: mapping.sourcePath,
      targetName: mapping.targetName,
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
    entries
  };
}

function syncPlugins({
  sourceType,
  targetPluginsRoot,
  check,
  preparedMappings,
  preparedWarnings,
  sourcePluginsDir,
  options,
  projectRoot,
  includeLegacyWhenRegistryAvailable = false
}) {
  let mappings = preparedMappings;
  let warnings = Array.isArray(preparedWarnings) ? [...preparedWarnings] : [];

  if (!Array.isArray(mappings)) {
    const resolved = buildPluginMappings({
      sourceType,
      options,
      projectRoot,
      registryPluginsDir: sourcePluginsDir,
      legacyPluginsDir: sourcePluginsDir,
      includeLegacyWhenRegistryAvailable
    });
    mappings = resolved.mappings;
    warnings.push(...resolved.warnings);
  }

  const report = syncPluginsFromMappings({
    mappings,
    targetPluginsRoot,
    sourceType,
    check
  });

  return {
    ...report,
    warnings
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

function normalizeMcpSyncOptions(options) {
  const safeOptions = options && typeof options === 'object' && !Array.isArray(options)
    ? options
    : {};

  return {
    ignoreMcpServers: Array.isArray(safeOptions.ignoreMcpServers)
      ? [...safeOptions.ignoreMcpServers]
      : [],
    mcpNameMap: safeOptions.mcpNameMap && typeof safeOptions.mcpNameMap === 'object' && !Array.isArray(safeOptions.mcpNameMap)
      ? { ...safeOptions.mcpNameMap }
      : {}
  };
}

function collectPluginMcpSources({ mappings, sourceType, options }) {
  const sources = [];
  const mcpOptions = normalizeMcpSyncOptions(options);

  for (const mapping of mappings) {
    const mcpPath = path.join(mapping.sourcePath, '.mcp.json');
    if (!fs.existsSync(mcpPath)) {
      continue;
    }

    sources.push({
      filePath: mcpPath,
      sourceLabel: `plugin-${sourceType}:${mapping.pluginName}`,
      options: mcpOptions
    });
  }

  return sources;
}

function collectPluginSkillMappings(sourceSkillsDir, pluginLabel, warnings) {
  const mappings = [];
  const usedTargets = new Set();

  for (const sourceName of listDirectories(sourceSkillsDir)) {
    const sourcePath = path.join(sourceSkillsDir, sourceName);
    const skillFilePath = path.join(sourcePath, 'SKILL.md');

    if (!fs.existsSync(skillFilePath)) {
      warnings.push(`插件 ${pluginLabel} 的技能目录 ${sourceName} 缺少 SKILL.md，已跳过`);
      continue;
    }

    const normalizedTarget = sanitizePathSegment(sourceName, sourceName);
    const targetName = resolveUniqueName(normalizedTarget, usedTargets);

    mappings.push({
      sourceName,
      sourcePath,
      targetName
    });
  }

  return mappings;
}

function syncPluginSkills({ pluginEntries, targetSkillsRoot, sourceType, check }) {
  const warnings = [];
  const added = [];
  const updated = [];
  const removed = [];

  const activePluginTargets = new Set();
  let pluginCount = 0;
  let sourceCount = 0;

  for (const entry of pluginEntries) {
    const sourceSkillsDir = path.join(entry.sourcePath, 'skills');
    const skillMappings = collectPluginSkillMappings(sourceSkillsDir, entry.pluginName, warnings);

    if (skillMappings.length === 0) {
      continue;
    }

    pluginCount += 1;
    sourceCount += skillMappings.length;
    activePluginTargets.add(entry.targetName);

    const targetPluginRoot = path.join(targetSkillsRoot, entry.targetName);
    const expectedSkillNames = new Set(skillMappings.map(skill => skill.targetName));
    const existingSkillDirs = listDirectories(targetPluginRoot);

    for (const skillMapping of skillMappings) {
      const targetPath = path.join(targetPluginRoot, skillMapping.targetName);
      const relativeName = `${entry.targetName}/${skillMapping.targetName}`;

      if (!fs.existsSync(targetPath)) {
        added.push(relativeName);
        if (!check) {
          fs.mkdirSync(targetPluginRoot, { recursive: true });
          fs.cpSync(skillMapping.sourcePath, targetPath, { recursive: true, force: true });
        }
        continue;
      }

      const sourceDigest = digestDirectory(skillMapping.sourcePath);
      const targetDigest = digestDirectory(targetPath);
      if (sourceDigest !== targetDigest) {
        updated.push(relativeName);
        if (!check) {
          fs.rmSync(targetPath, { recursive: true, force: true });
          fs.cpSync(skillMapping.sourcePath, targetPath, { recursive: true, force: true });
        }
      }
    }

    for (const existingSkillDir of existingSkillDirs) {
      if (expectedSkillNames.has(existingSkillDir)) {
        continue;
      }

      removed.push(`${entry.targetName}/${existingSkillDir}`);
      if (!check) {
        fs.rmSync(path.join(targetPluginRoot, existingSkillDir), { recursive: true, force: true });
      }
    }
  }

  const existingPluginDirs = listDirectories(targetSkillsRoot);
  for (const existingPluginDir of existingPluginDirs) {
    if (activePluginTargets.has(existingPluginDir)) {
      continue;
    }

    removed.push(existingPluginDir);
    if (!check) {
      fs.rmSync(path.join(targetSkillsRoot, existingPluginDir), { recursive: true, force: true });
    }
  }

  return {
    sourceType,
    changed: added.length > 0 || updated.length > 0 || removed.length > 0,
    pluginCount,
    sourceCount,
    targetRoot: targetSkillsRoot,
    added: added.sort((a, b) => a.localeCompare(b)),
    updated: updated.sort((a, b) => a.localeCompare(b)),
    removed: removed.sort((a, b) => a.localeCompare(b)),
    warnings
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
  const homeOptions = loadSyncOptions(path.join(claudeHome, '.codex-sync.json'));
  const projectOptions = projectRoot
    ? loadSyncOptions(path.join(projectRoot, '.claude-codex-sync.json'))
    : { ...DEFAULT_OPTIONS };

  const homePluginInput = includeHome
    ? buildPluginMappings({
      sourceType: 'home',
      options: homeOptions,
      projectRoot,
      registryPluginsDir: path.join(claudeHome, 'plugins'),
      legacyPluginsDir: path.join(claudeHome, 'plugins')
    })
    : { mappings: [], warnings: [] };

  const projectPluginInput = includeProject && projectRoot
    ? buildPluginMappings({
      sourceType: 'project',
      options: projectOptions,
      projectRoot,
      registryPluginsDir: path.join(claudeHome, 'plugins'),
      legacyPluginsDir: path.join(projectRoot, '.claude', 'plugins'),
      includeLegacyWhenRegistryAvailable: true
    })
    : { mappings: [], warnings: [] };

  const extraMcpSources = [
    ...collectPluginMcpSources({
      mappings: homePluginInput.mappings,
      sourceType: 'home',
      options: homeOptions
    }),
    ...collectPluginMcpSources({
      mappings: projectPluginInput.mappings,
      sourceType: 'project',
      options: projectOptions
    })
  ];

  const baseReport = syncBaseSources({
    projectRoot,
    claudeHome,
    codexHome,
    check,
    includeHome,
    includeProject,
    extraMcpSources
  });

  const pluginReports = [];
  const hookReports = [];
  const pluginSkillReports = [];
  const warnings = [...(baseReport.warnings || [])];

  if (includeHome) {
    const homePlugins = syncPlugins({
      sourceType: 'home',
      targetPluginsRoot: path.join(codexHome, 'plugins', 'claude-home'),
      check,
      preparedMappings: homePluginInput.mappings,
      preparedWarnings: homePluginInput.warnings
    });
    pluginReports.push({ source: 'home', ...homePlugins });
    warnings.push(...homePlugins.warnings);

    const homePluginSkills = syncPluginSkills({
      pluginEntries: homePlugins.entries,
      targetSkillsRoot: path.join(codexHome, 'skills', 'claude-home', 'plugins'),
      sourceType: 'home',
      check
    });
    pluginSkillReports.push(homePluginSkills);
    warnings.push(...homePluginSkills.warnings);

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
      sourceType: 'project',
      targetPluginsRoot: path.join(codexHome, 'plugins', 'project', path.basename(projectRoot)),
      check,
      preparedMappings: projectPluginInput.mappings,
      preparedWarnings: projectPluginInput.warnings
    });
    pluginReports.push({ source: 'project', ...projectPlugins });
    warnings.push(...projectPlugins.warnings);

    const projectPluginSkills = syncPluginSkills({
      pluginEntries: projectPlugins.entries,
      targetSkillsRoot: path.join(codexHome, 'skills', 'project', path.basename(projectRoot), 'plugins'),
      sourceType: 'project',
      check
    });
    pluginSkillReports.push(projectPluginSkills);
    warnings.push(...projectPluginSkills.warnings);

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
  const pluginSkillsChanged = pluginSkillReports.some(item => item.changed);

  return {
    changed: Boolean(baseReport.changed || pluginsChanged || hooksChanged || pluginSkillsChanged || docAliases.changed || bridgeManifest.changed),
    check,
    claudeHome,
    codexHome,
    projectRoot,
    includeHome,
    includeProject,
    baseReport,
    pluginReports,
    hookReports,
    pluginSkillReports,
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

  console.log('\n🧩 Plugin Skills:');
  if (report.pluginSkillReports.length === 0) {
    console.log('- 本次未启用 plugin skills 同步');
  }
  for (const item of report.pluginSkillReports) {
    console.log(`- [${item.sourceType}] 插件数: ${item.pluginCount}，技能数: ${item.sourceCount}`);
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
  buildPluginMappings,
  collectPluginMcpSources,
  parseHookDefinitions,
  syncDocAliases,
  syncHooksDir,
  syncPluginSkills,
  syncPlugins,
  syncRuntimeSources
};
