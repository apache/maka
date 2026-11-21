# cc —— 个人工作区私仓

一处私有、可同步、可追溯的个人资产库。**作为新项目阅读**：下面用分论点介绍每个文件夹是什么；各文件夹内部有自己的 README 负责第二层细节。

## 顶层文件夹

- **`web/docs/`** — 个人知识库。版本锁在 `web/docs/skills-lock.json`。会话在 [web/docs/sessions/README.md](web/docs/sessions/README.md)。
- **`web/scripts/`** — cc 仓与家目录的运维脚本。详见 [web/scripts/README.md](web/scripts/README.md)。
- **`code/`** — `github/` 第三方收藏、`repositories/` 自管项目、`fork/` 开源贡献、`paused/` 暂停区。入口见 [code/github/README.md](code/github/README.md)、[code/repositories/README.md](code/repositories/README.md)、[web/docs/fork/README.md](web/docs/fork/README.md)。

- **`AGENTS.md` / `CLAUDE.md`** — 全仓 AI 编码指导入口（ZCode/Claude Code 自动读取）；Go Skills 索引见 [.agents/skills/README.md](.agents/skills/README.md)，版本锁在 `web/docs/skills-lock.json`。

## 核心项目速览

- **[code/repositories/private/lab/console](code/repositories/private/lab/console)** — 个人综合大仓（pnpm monorepo）：7 个 Next.js 应用（运维控制台 65501 / 博客 65502 / 工具箱 65503 / AI Agent 线 65504 / 若依形制管理后台 65505 / 门户 65515）+ 10 个核心包，后端统一 Next API Routes + node:sqlite。
- **[web](web/README.md)** — 项目资产库，按业务域分区：美业(meiye) + 康养(senior)；个人开发知识库在 web/美业(meiye)/07-知识库。
- **[web/docs/fork](web/docs/fork/README.md)** — 开源贡献台账正本。
- **[web/docs/sessions](web/docs/sessions/README.md)** — AI 会话归档。

## 跟踪策略

根 [.gitignore](.gitignore) 白名单制（`*` 起手、`!` 放行），各被接圈子树自带的 `.gitignore` 在其子树内继续生效。fork 与 reverse 下的上游克隆、`repositories/` 下的独立仓、大文件与本地状态不入库（reverse 仅留 README 轮廓）。

## 仓库操作

- 本仓 origin 走 HTTPS（gh 凭证助手）；推送勿用 ssh（本机 22 端口 git 通道不稳）。
- Windows 侧（`E:\cc\*` 对应克隆）需同步本仓的重置/迁移口径后拉取。
