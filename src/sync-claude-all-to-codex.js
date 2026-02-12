#!/usr/bin/env node

/**
 * 同步 ~/.claude 与当前项目 .claude 的能力到 Codex。
 *
 * 目标：让 .claude 成为唯一真源。
 * - Skills: ~/.claude/skills + <repo>/.claude/skills
 * - MCP:    ~/.claude/mcp.json(或 ~/.claude/.mcp.json) + <repo>/.mcp.json
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const MANAGED_BLOCK_START = '# >>> claude-codex-sync:managed-mcp:start >>>';
const MANAGED_BLOCK_END = '# <<< claude-codex-sync:managed-mcp:end <<<';

const DEFAULT_SYNC_OPTIONS = {
  ignoreSkills: [],
  ignorePlugins: [],
  ignoreMcpServers: [],
  skillNameMap: {},
  pluginNameMap: {},
  mcpNameMap: {}
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

function normalizeSyncOptions(userOptions, configPath) {
  const merged = {
    ...DEFAULT_SYNC_OPTIONS,
    ...(userOptions || {})
  };

  for (const key of ['ignoreSkills', 'ignorePlugins', 'ignoreMcpServers']) {
    if (!Array.isArray(merged[key])) {
      throw new Error(`${configPath} 中 ${key} 必须是数组`);
    }
  }

  for (const key of ['skillNameMap', 'pluginNameMap', 'mcpNameMap']) {
    const value = merged[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${configPath} 中 ${key} 必须是对象`);
    }
  }

  return merged;
}

function loadSyncOptions(configPath) {
  const userOptions = readJsonIfExists(configPath);
  if (!userOptions) {
    return { ...DEFAULT_SYNC_OPTIONS };
  }

  return normalizeSyncOptions(userOptions, configPath);
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

function sanitizePathSegment(value, fallback) {
  const cleaned = value.replace(/[\\/]/g, '-').trim();
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

function buildSkillMappings(sourceSkillsDir, options) {
  const ignoreSet = new Set(options.ignoreSkills);
  const sourceDirs = listDirectories(sourceSkillsDir);
  const warnings = [];
  const mappings = [];
  const usedTargets = new Set();

  for (const sourceName of sourceDirs) {
    if (ignoreSet.has(sourceName)) {
      continue;
    }

    const sourcePath = path.join(sourceSkillsDir, sourceName);
    const skillFilePath = path.join(sourcePath, 'SKILL.md');

    if (!fs.existsSync(skillFilePath)) {
      warnings.push(`技能目录 ${sourceName} 缺少 SKILL.md，已跳过`);
      continue;
    }

    const mappedName = options.skillNameMap[sourceName] || sourceName;
    const normalizedTarget = sanitizePathSegment(mappedName, sourceName);
    const targetName = resolveUniqueName(normalizedTarget, usedTargets);

    mappings.push({
      sourceName,
      targetName,
      sourcePath
    });
  }

  return { mappings, warnings };
}

function syncSkills({ sourceSkillsDir, targetSkillsRoot, options, check }) {
  const { mappings, warnings } = buildSkillMappings(sourceSkillsDir, options);
  const targetNames = new Set(mappings.map(item => item.targetName));

  const existingTargetDirs = listDirectories(targetSkillsRoot);
  const added = [];
  const updated = [];
  const removed = [];

  for (const mapping of mappings) {
    const targetPath = path.join(targetSkillsRoot, mapping.targetName);

    if (!fs.existsSync(targetPath)) {
      added.push(mapping.targetName);
      if (!check) {
        fs.mkdirSync(targetSkillsRoot, { recursive: true });
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
      fs.rmSync(path.join(targetSkillsRoot, existingDir), { recursive: true, force: true });
    }
  }

  const changed = added.length > 0 || updated.length > 0 || removed.length > 0;

  return {
    changed,
    sourceCount: mappings.length,
    targetRoot: targetSkillsRoot,
    added: added.sort((a, b) => a.localeCompare(b)),
    updated: updated.sort((a, b) => a.localeCompare(b)),
    removed: removed.sort((a, b) => a.localeCompare(b)),
    warnings
  };
}

function normalizeMcpKey(name) {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (normalized) {
    return normalized;
  }

  const hash = crypto.createHash('sha1').update(name).digest('hex').slice(0, 8);
  return `mcp-${hash}`;
}

function coerceArrayOfScalars(value, defaultValue) {
  if (!Array.isArray(value)) {
    return defaultValue;
  }

  return value.filter(item => ['string', 'number', 'boolean'].includes(typeof item));
}

function coerceObjectOfScalars(value, defaultValue) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return defaultValue;
  }

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (['string', 'number', 'boolean'].includes(typeof item)) {
      result[key] = item;
    }
  }

  return result;
}

function pickMcpServerConfig(rawServerConfig, sourceName, warnings) {
  const config = {};

  if (typeof rawServerConfig.command === 'string' && rawServerConfig.command.trim()) {
    config.command = rawServerConfig.command;
  }

  const args = coerceArrayOfScalars(rawServerConfig.args, null);
  if (args && args.length > 0) {
    config.args = args;
  }

  if (typeof rawServerConfig.url === 'string' && rawServerConfig.url.trim()) {
    config.url = rawServerConfig.url;
  }

  if (typeof rawServerConfig.cwd === 'string' && rawServerConfig.cwd.trim()) {
    config.cwd = rawServerConfig.cwd;
  }

  const env = coerceObjectOfScalars(rawServerConfig.env, null);
  if (env && Object.keys(env).length > 0) {
    config.env = env;
  }

  if (rawServerConfig.transport) {
    warnings.push(`MCP ${sourceName} 的 transport=${rawServerConfig.transport} 未同步到 Codex（已忽略）`);
  }

  if (rawServerConfig.headers) {
    warnings.push(`MCP ${sourceName} 的 headers 字段未同步到 Codex（已忽略）`);
  }

  if (!config.command && !config.url) {
    warnings.push(`MCP ${sourceName} 缺少 command 或 url，已跳过`);
    return null;
  }

  return config;
}

function tomlKey(key) {
  if (/^[A-Za-z0-9_-]+$/.test(key)) {
    return key;
  }

  return JSON.stringify(key);
}

function tomlString(value) {
  return JSON.stringify(value);
}

function tomlValue(value) {
  if (typeof value === 'string') {
    return tomlString(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => tomlValue(item)).join(', ')}]`;
  }

  if (value && typeof value === 'object') {
    const pairs = Object.keys(value)
      .sort((a, b) => a.localeCompare(b))
      .map(key => `${tomlKey(key)} = ${tomlValue(value[key])}`);
    return `{ ${pairs.join(', ')} }`;
  }

  throw new Error(`不支持的 TOML 值类型: ${typeof value}`);
}

function buildManagedMcpBlock(servers) {
  const lines = [];
  const entryMap = {};

  lines.push(MANAGED_BLOCK_START);
  lines.push('# Auto-generated by scripts/sync-claude-all-to-codex.js');

  const serverNames = Object.keys(servers).sort((a, b) => a.localeCompare(b));
  if (serverNames.length === 0) {
    lines.push('# No managed MCP servers found from claude sources');
  }

  for (const serverName of serverNames) {
    const server = servers[serverName];
    const entryLines = [`[mcp_servers.${serverName}]`];

    for (const key of Object.keys(server).sort((a, b) => a.localeCompare(b))) {
      entryLines.push(`${tomlKey(key)} = ${tomlValue(server[key])}`);
    }

    entryMap[serverName] = `${entryLines.join('\n')}\n`;

    lines.push('');
    lines.push(...entryLines);
  }

  lines.push(MANAGED_BLOCK_END);
  return {
    blockText: `${lines.join('\n')}\n`,
    entryMap
  };
}

function extractManagedBlock(configText) {
  const start = configText.indexOf(MANAGED_BLOCK_START);
  if (start === -1) {
    return null;
  }

  const end = configText.indexOf(MANAGED_BLOCK_END, start);
  if (end === -1) {
    return null;
  }

  let blockEnd = end + MANAGED_BLOCK_END.length;
  if (configText[blockEnd] === '\n') {
    blockEnd += 1;
  }

  return {
    start,
    end: blockEnd,
    blockText: configText.slice(start, blockEnd)
  };
}

function parseMcpEntryMapFromBlock(blockText) {
  const map = {};
  const lines = blockText.split('\n');

  let currentName = null;
  let buffer = [];

  function flush() {
    if (!currentName) {
      return;
    }

    map[currentName] = `${buffer.join('\n').trim()}\n`;
  }

  for (const line of lines) {
    const tableMatch = line.match(/^\[mcp_servers\.([A-Za-z0-9_-]+)]\s*$/);
    if (tableMatch) {
      flush();
      currentName = tableMatch[1];
      buffer = [line];
      continue;
    }

    if (currentName) {
      if (line.startsWith('# <<<')) {
        flush();
        currentName = null;
        buffer = [];
      } else {
        buffer.push(line);
      }
    }
  }

  flush();
  return map;
}

function applyManagedBlock(configText, blockText) {
  const existing = extractManagedBlock(configText);

  if (!existing) {
    if (!configText.trim()) {
      return blockText;
    }

    const separator = configText.endsWith('\n') ? '\n' : '\n\n';
    return `${configText}${separator}${blockText}`;
  }

  return `${configText.slice(0, existing.start)}${blockText}${configText.slice(existing.end)}`;
}

function collectServersFromFile({
  filePath,
  sourceLabel,
  options,
  mergedServers,
  warnings,
  sourceTrace
}) {
  if (!filePath || !fs.existsSync(filePath)) {
    return false;
  }

  const mcpJson = readJsonIfExists(filePath);
  const servers = mcpJson && mcpJson.mcpServers;

  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    warnings.push(`${sourceLabel} 的 mcp 配置缺少 mcpServers 对象：${filePath}`);
    return false;
  }

  const ignoreSet = new Set(options.ignoreMcpServers);

  for (const sourceName of Object.keys(servers).sort((a, b) => a.localeCompare(b))) {
    if (ignoreSet.has(sourceName)) {
      continue;
    }

    const rawServer = servers[sourceName];
    if (!rawServer || typeof rawServer !== 'object' || Array.isArray(rawServer)) {
      warnings.push(`${sourceLabel} 的 MCP ${sourceName} 结构不合法，已跳过`);
      continue;
    }

    const mappedName = options.mcpNameMap[sourceName] || sourceName;
    const normalizedName = normalizeMcpKey(mappedName);
    const config = pickMcpServerConfig(rawServer, `${sourceLabel}/${sourceName}`, warnings);
    if (!config) {
      continue;
    }

    if (mergedServers[normalizedName]) {
      warnings.push(
        `MCP ${normalizedName} 由 ${sourceLabel} 覆盖 ${sourceTrace[normalizedName]}（后者优先）`
      );
    }

    mergedServers[normalizedName] = config;
    sourceTrace[normalizedName] = sourceLabel;
  }

  return true;
}

function chooseHomeMcpPath(claudeHome) {
  const candidates = [
    path.join(claudeHome, 'mcp.json'),
    path.join(claudeHome, '.mcp.json')
  ];

  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function resolveHomeMcpTargetPath(claudeHome) {
  return chooseHomeMcpPath(claudeHome) || path.join(claudeHome, 'mcp.json');
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

function mirrorProjectMcpIntoHome({ claudeHome, projectRoot, check }) {
  const projectMcpPath = path.join(projectRoot, '.mcp.json');
  if (!fs.existsSync(projectMcpPath)) {
    return {
      enabled: false,
      changed: false,
      sourcePath: projectMcpPath,
      targetPath: null,
      addedOrUpdated: [],
      removed: [],
      warnings: ['项目 .mcp.json 不存在，跳过 project -> ~/.claude mcp 镜像']
    };
  }

  const projectJson = readJsonIfExists(projectMcpPath);
  const projectServers = projectJson && projectJson.mcpServers;
  if (!projectServers || typeof projectServers !== 'object' || Array.isArray(projectServers)) {
    throw new Error(`${projectMcpPath} 缺少 mcpServers 对象`);
  }

  const targetPath = resolveHomeMcpTargetPath(claudeHome);
  const targetJson = readJsonIfExists(targetPath) || { mcpServers: {} };
  const targetServers = targetJson.mcpServers;
  if (!targetServers || typeof targetServers !== 'object' || Array.isArray(targetServers)) {
    throw new Error(`${targetPath} 缺少 mcpServers 对象`);
  }

  const statePath = path.join(claudeHome, '.codex-project-mcp-sync-state.json');
  const stateJson = readJsonIfExists(statePath) || { projects: {} };
  const projectsState = stateJson.projects && typeof stateJson.projects === 'object' && !Array.isArray(stateJson.projects)
    ? stateJson.projects
    : {};

  const projectKey = path.resolve(projectRoot);
  const previousNames = Array.isArray(projectsState[projectKey]) ? projectsState[projectKey] : [];
  const nextNames = Object.keys(projectServers).sort((a, b) => a.localeCompare(b));

  const mergedServers = { ...targetServers };
  const removed = [];

  for (const oldName of previousNames) {
    if (!Object.prototype.hasOwnProperty.call(projectServers, oldName) && Object.prototype.hasOwnProperty.call(mergedServers, oldName)) {
      delete mergedServers[oldName];
      removed.push(oldName);
    }
  }

  for (const [name, serverConfig] of Object.entries(projectServers)) {
    mergedServers[name] = serverConfig;
  }

  const oldPayload = { mcpServers: targetServers };
  const nextPayload = { mcpServers: mergedServers };
  const payloadChanged = stableStringify(oldPayload) !== stableStringify(nextPayload);

  const nextState = {
    projects: {
      ...projectsState,
      [projectKey]: nextNames
    }
  };
  const stateChanged = stableStringify({ projects: projectsState }) !== stableStringify(nextState);
  const changed = payloadChanged || stateChanged;

  if (changed && !check) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, `${JSON.stringify(nextPayload, null, 2)}
`, 'utf8');

    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(nextState, null, 2)}
`, 'utf8');
  }

  return {
    enabled: true,
    changed,
    sourcePath: projectMcpPath,
    targetPath,
    addedOrUpdated: nextNames,
    removed: removed.sort((a, b) => a.localeCompare(b)),
    warnings: []
  };
}

function normalizeMcpOptions(options) {
  const safeOptions = options && typeof options === 'object' && !Array.isArray(options)
    ? options
    : {};

  return {
    ignoreMcpServers: Array.isArray(safeOptions.ignoreMcpServers) ? safeOptions.ignoreMcpServers : [],
    mcpNameMap: safeOptions.mcpNameMap && typeof safeOptions.mcpNameMap === 'object' && !Array.isArray(safeOptions.mcpNameMap)
      ? safeOptions.mcpNameMap
      : {}
  };
}

function syncMergedMcp({
  codexHome,
  check,
  home,
  project,
  extraSources = []
}) {
  const warnings = [];
  const mergedServers = {};
  const sourceTrace = {};
  const sourceFiles = [];

  const normalizedExtraSources = Array.isArray(extraSources) ? extraSources : [];
  for (const source of normalizedExtraSources) {
    if (!source || typeof source !== 'object') {
      continue;
    }

    const sourceLabel = typeof source.sourceLabel === 'string' && source.sourceLabel.trim()
      ? source.sourceLabel.trim()
      : 'extra';
    const sourcePath = typeof source.filePath === 'string' ? source.filePath : null;
    if (!sourcePath) {
      continue;
    }

    const sourceDisplay = `${sourceLabel}:${sourcePath}`;
    const safeOptions = normalizeMcpOptions(source.options);

    if (collectServersFromFile({
      filePath: sourcePath,
      sourceLabel,
      options: safeOptions,
      mergedServers,
      warnings,
      sourceTrace
    })) {
      sourceFiles.push(sourceDisplay);
    } else {
      sourceFiles.push(sourceDisplay);
    }
  }

  if (home && home.enabled) {
    if (collectServersFromFile({
      filePath: home.mcpPath,
      sourceLabel: 'home',
      options: normalizeMcpOptions(home.options),
      mergedServers,
      warnings,
      sourceTrace
    })) {
      sourceFiles.push(home.mcpPath);
    } else if (home.mcpPath) {
      sourceFiles.push(home.mcpPath);
    } else {
      warnings.push('未找到 ~/.claude/mcp.json（或 ~/.claude/.mcp.json），已跳过 home MCP');
    }
  }

  if (project && project.enabled) {
    if (collectServersFromFile({
      filePath: project.mcpPath,
      sourceLabel: 'project',
      options: normalizeMcpOptions(project.options),
      mergedServers,
      warnings,
      sourceTrace
    })) {
      sourceFiles.push(project.mcpPath);
    } else if (project.mcpPath) {
      sourceFiles.push(project.mcpPath);
    }
  }

  if (sourceFiles.length === 0) {
    return {
      changed: false,
      skipped: true,
      configPath: path.join(codexHome, 'config.toml'),
      sourcePaths: [],
      added: [],
      updated: [],
      removed: [],
      managedCount: 0,
      warnings
    };
  }

  const { blockText, entryMap: newEntryMap } = buildManagedMcpBlock(mergedServers);
  const configPath = path.join(codexHome, 'config.toml');
  const oldConfigText = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const oldManaged = extractManagedBlock(oldConfigText);
  const oldEntryMap = oldManaged ? parseMcpEntryMapFromBlock(oldManaged.blockText) : {};

  const newConfigText = applyManagedBlock(oldConfigText, blockText);
  const changed = newConfigText !== oldConfigText;

  if (changed && !check) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, newConfigText, 'utf8');
  }

  const oldNames = new Set(Object.keys(oldEntryMap));
  const newNames = new Set(Object.keys(newEntryMap));

  const added = [...newNames].filter(name => !oldNames.has(name)).sort((a, b) => a.localeCompare(b));
  const removed = [...oldNames].filter(name => !newNames.has(name)).sort((a, b) => a.localeCompare(b));
  const updated = [...newNames]
    .filter(name => oldNames.has(name) && oldEntryMap[name] !== newEntryMap[name])
    .sort((a, b) => a.localeCompare(b));

  return {
    changed,
    skipped: false,
    configPath,
    sourcePaths: sourceFiles,
    added,
    updated,
    removed,
    managedCount: Object.keys(newEntryMap).length,
    warnings
  };
}

function syncSources({ projectRoot, claudeHome, codexHome, check, includeHome, includeProject, extraMcpSources = [] }) {
  const homeOptions = loadSyncOptions(path.join(claudeHome, '.codex-sync.json'));
  const projectOptions = projectRoot
    ? loadSyncOptions(path.join(projectRoot, '.claude-codex-sync.json'))
    : { ...DEFAULT_SYNC_OPTIONS };

  const skillsReports = [];
  const warnings = [];

  if (includeHome) {
    const homeSkills = syncSkills({
      sourceSkillsDir: path.join(claudeHome, 'skills'),
      targetSkillsRoot: path.join(codexHome, 'skills', 'claude-home'),
      options: homeOptions,
      check
    });

    skillsReports.push({ source: 'home', ...homeSkills });
    warnings.push(...homeSkills.warnings);
  }

  if (includeProject && projectRoot) {
    const projectSkills = syncSkills({
      sourceSkillsDir: path.join(projectRoot, '.claude', 'skills'),
      targetSkillsRoot: path.join(codexHome, 'skills', 'project', path.basename(projectRoot)),
      options: projectOptions,
      check
    });

    skillsReports.push({ source: 'project', ...projectSkills });
    warnings.push(...projectSkills.warnings);
  }

  let projectMcpMirror = {
    enabled: false,
    changed: false,
    sourcePath: projectRoot ? path.join(projectRoot, '.mcp.json') : null,
    targetPath: null,
    addedOrUpdated: [],
    removed: [],
    warnings: []
  };

  if (includeHome && includeProject && projectRoot) {
    projectMcpMirror = mirrorProjectMcpIntoHome({
      claudeHome,
      projectRoot,
      check
    });
    warnings.push(...projectMcpMirror.warnings);
  }

  const mcp = syncMergedMcp({
    codexHome,
    check,
    home: {
      enabled: includeHome,
      mcpPath: includeHome ? resolveHomeMcpTargetPath(claudeHome) : null,
      options: homeOptions
    },
    project: {
      enabled: includeProject && Boolean(projectRoot) && !projectMcpMirror.enabled,
      mcpPath: projectRoot ? path.join(projectRoot, '.mcp.json') : null,
      options: projectOptions
    },
    extraSources: extraMcpSources
  });

  warnings.push(...mcp.warnings);

  const skillsChanged = skillsReports.some(item => item.changed);

  return {
    changed: skillsChanged || mcp.changed || projectMcpMirror.changed,
    check,
    claudeHome,
    codexHome,
    projectRoot,
    includeHome,
    includeProject,
    skillsReports,
    mcp,
    projectMcpMirror,
    warnings
  };
}

function printReport(report) {
  const modeText = report.check ? '检查模式（不写入）' : '同步模式（会写入）';
  console.log(`\n🔄 Claude(全局+项目) → Codex 同步：${modeText}`);
  console.log(`🏠 Claude Home: ${report.claudeHome}`);
  console.log(`🏠 Codex Home: ${report.codexHome}`);
  console.log(`📁 Project Root: ${report.projectRoot || '无（仅全局）'}`);

  console.log('\n🧩 Skills:');
  if (report.skillsReports.length === 0) {
    console.log('- 本次未启用 skills 同步');
  }

  for (const item of report.skillsReports) {
    console.log(`- [${item.source}] 来源数量: ${item.sourceCount}`);
    console.log(`  目标目录: ${item.targetRoot}`);
    console.log(`  新增: ${item.added.length > 0 ? item.added.join(', ') : '无'}`);
    console.log(`  更新: ${item.updated.length > 0 ? item.updated.join(', ') : '无'}`);
    console.log(`  删除: ${item.removed.length > 0 ? item.removed.join(', ') : '无'}`);
  }

  if (report.projectMcpMirror && report.projectMcpMirror.enabled) {
    console.log('\n↔ Home MCP Mirror:');
    console.log(`- 来源配置: ${report.projectMcpMirror.sourcePath}`);
    console.log(`- 目标配置: ${report.projectMcpMirror.targetPath}`);
    console.log(`- 同步(新增或更新): ${report.projectMcpMirror.addedOrUpdated.length > 0 ? report.projectMcpMirror.addedOrUpdated.join(', ') : '无'}`);
    console.log(`- 移除(已不在项目中): ${report.projectMcpMirror.removed.length > 0 ? report.projectMcpMirror.removed.join(', ') : '无'}`);
  }

  console.log('\n🔌 MCP:');
  if (report.mcp.skipped) {
    console.log('- 未发现可用 mcp 源文件，本次跳过 mcp 同步');
  } else {
    console.log(`- 来源配置: ${report.mcp.sourcePaths.join(' | ')}`);
    console.log(`- 目标配置: ${report.mcp.configPath}`);
    console.log(`- 托管 server 数量: ${report.mcp.managedCount}`);
    console.log(`- 新增: ${report.mcp.added.length > 0 ? report.mcp.added.join(', ') : '无'}`);
    console.log(`- 更新: ${report.mcp.updated.length > 0 ? report.mcp.updated.join(', ') : '无'}`);
    console.log(`- 删除: ${report.mcp.removed.length > 0 ? report.mcp.removed.join(', ') : '无'}`);
  }

  const warningSet = [...new Set(report.warnings)];
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

  const report = syncSources({
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
  MANAGED_BLOCK_START,
  MANAGED_BLOCK_END,
  applyManagedBlock,
  buildManagedMcpBlock,
  parseMcpEntryMapFromBlock,
  syncSkills,
  syncSources
};
