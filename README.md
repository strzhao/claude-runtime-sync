# claude-runtime-sync

Use Claude config (`~/.claude` + `<repo>/.claude`) as the **single source of truth**, and sync reusable runtime capabilities into Codex.

## Features

- Sync skills from Claude to Codex
- Sync MCP servers into managed block of `~/.codex/config.toml`
- Mirror project `.mcp.json` into `~/.claude/mcp.json`
- Sync Claude plugins and hooks metadata into Codex runtime area
- Generate bridge manifest for Codex event -> Claude hooks mapping
- Keep `agents.md` / `gemini.md` aligned with `CLAUDE.md` (symlink-first)
- Install zsh startup hook for auto-check + auto-sync before each `codex` launch

## Install

```bash
npm i -g claude-runtime-sync
```

## CLI

```bash
crs sync
crs check
crs bridge --watch
crs hook install
crs hook remove
crs sync-base
```

## Common flags

```bash
--project-root=/path/to/repo
--claude-home=/path/to/.claude
--codex-home=/path/to/.codex
--no-home
--no-project
```

## Recommended bootstrap

```bash
# 1) one-time hook install
crs hook install

# 2) verify drift state
crs check

# 3) apply sync if needed
crs sync
```

## Local development

```bash
npm run check
npm run smoke
npm run pack:dry-run
```

## GitHub Actions

This repo includes:

- `.github/workflows/ci.yml`: syntax check + CLI smoke + pack dry run
- `.github/workflows/publish.yml`: publish to npm on `v*` tag or manual dispatch

Required repository secret:

- `NPM_TOKEN`: npm automation token with publish permission

## Publish flow

```bash
# bump version first
npm version patch

# publish from local (optional)
npm publish --access public

# or publish via CI
# git push --follow-tags
```

## Notes

- Event bridge uses structured Codex session events and maps them to Claude-style hook events.
- If you only need base sync (skills + mcp), run `crs sync-base`.
- Example project config: `examples/.claude-codex-sync.example.json`.

## License

MIT
