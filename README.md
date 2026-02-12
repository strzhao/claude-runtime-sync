# claude-runtime-sync

让你把 Claude 配置（`~/.claude` + 项目内 `.claude`）作为唯一真实源，并自动复用到 Codex。

适合不想记很多命令的用户：**装好后基本只用 `codex`。**

## 30 秒上手（推荐）

```bash
# 1) 全局安装（一次）
npm i -g claude-runtime-sync

# 2) 接入 codex 启动流程（一次）
crs hook install

# 3) 首次手动同步（一次）
crs sync
```

之后日常直接：

```bash
codex
```

`codex` 每次启动前会自动检查并在需要时同步。

---

## 它会帮你自动处理什么

- 同步 skills（`~/.claude/skills` + `<repo>/.claude/skills`）
- 同步 MCP 到 `~/.codex/config.toml` 托管区块
- 镜像项目 `.mcp.json` 到 `~/.claude/mcp.json`（保持 `.claude` 为真源）
- 同步已启用 Claude plugins（目录 + hooks + plugin 内 skills + plugin 内 .mcp.json）
- 把 `CLAUDE.md` 复用到 `agents.md` / `gemini.md`（软链接优先）
- 通过 bridge 将 Codex 事件映射到 Claude 风格 hooks

---

## 日常使用（你只需要记这些）

### 1) 平时开发

```bash
codex
```

### 2) 改了 `.claude` / `.mcp.json` 后，想立即生效

```bash
crs sync
```

### 3) 想确认是否有漂移

```bash
crs check
```

---

## 常用命令（精简版）

```bash
crs sync             # 执行同步
crs check            # 只检查差异（有差异返回码 1）
crs hook install     # 安装 zsh 自动同步钩子
crs hook remove      # 卸载钩子
crs bridge --watch   # 手动运行事件桥接（一般不需要）
crs sync-base        # 仅同步 skills + mcp
```

---

## 可选参数（按需）

```bash
--project-root=/path/to/repo
--claude-home=/path/to/.claude
--codex-home=/path/to/.codex
--no-home
--no-project
```

---

## 排障（只在需要时看）

- 临时关闭自动同步：
  ```bash
  CODEX_SYNC_DISABLE=1 codex
  ```
- 临时关闭插件桥接：
  ```bash
  CODEX_PLUGIN_BRIDGE_DISABLE=1 codex
  ```
- 重新安装钩子：
  ```bash
  crs hook remove
  crs hook install
  ```

---

## 使用前提

- Node.js >= 18
- 已安装 `codex` CLI
- 当前自动 hook 入口为 **zsh**（`crs hook install`）

---

## 发布者本地检查（维护者）

```bash
npm run check
npm run smoke
npm run pack:dry-run
```

## License

MIT
