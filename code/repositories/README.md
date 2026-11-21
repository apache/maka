# repositories — 自管理项目集中地

公仓各自有 Git，根 `.gitignore` 排除，不进本仓。`private/` 在白名单 `code/repositories/**` 里。

- **`public/`** — 有远程的开源/个人仓（coding-agent、agent-hub、language、cursor-loc、qoder-proxy-api、syntax-party），独立开发与推送。见 [public/README.md](public/README.md)。
- **`private/`** — 本地私有项目。见 [private/README.md](private/README.md)。
  - `private/lab/` — 实验区：综合大仓 **console**（apps 7 + packages 10）、skills-explorer 与杂项。见 [lab/README.md](private/lab/README.md)。
  - `private/work/` — 贡献工作区（work/hub 八仓工作文档、pr、guide 等活文档，2026-10-25 自 `cc/work` 迁入）。见 [work/README.md](private/work/README.md)。

## 2026-10-25 迁移注记

原 `cc/work`、`cc/lab` 已整体迁入本目录；cc 根 `.gitignore` 白名单同步切换为放行 `repositories/`。自带 `.git` 的仓在本仓 git 视角为嵌套仓（仅 gitlink/未跟踪条目），内容以各自仓为准。
