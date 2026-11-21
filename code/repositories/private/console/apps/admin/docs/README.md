# docs —— liliya Go 版退役归档（2026-10-25）

Node 版（apps/admin，本应用）于 2026-10-25 完成对 Go 版（原 `lab/liliya`）的全部核心功能对齐后，Go 版退役。本目录收存退役前的定版资料：

| 文件 | 内容 |
| --- | --- |
| `liliya-go-history.bundle` | Go 版完整 12 提交 git 历史（恢复：`git clone liliya-go-history.bundle 目录名`） |
| `2026-10-06-liliya垂直切片-需求澄清.md` | 项目边界与决策记录（schema 复用/密码算法/切片范围等 8 项口径） |
| `README-原仓.md` | Go 版 README（P0~P3 功能清单与运行方式） |
| `ARCHITECTURE.md` / `LESSONS.md` / `AGENTS.md` | Go 版架构说明、工程教训与协作约定 |

## 功能继承对照（Go → Node）

全部 CRUD/RBAC/调度/验证码/仪表盘/个人中心/options 已在 Node 版实现（见应用 README 的两批交付记录）。**明确裁剪项**（Go 有、Node 不做）：存量 MySQL 直连（SQLite 自建库替代）、代码生成器、租户管理、服务/缓存监控、Excel 导入导出、XSS 中间件、OpenAPI 端点、smoke_p1~p7 Python 回归脚本（Go+MySQL 专用，Node 以 curl e2e 替代）。
