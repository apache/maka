# docs —— 个人知识库

2026-10-25 铺平重构：取消 `ref/study/未整理` 三层分组，一级目录即分类。贡献手册在本目录 `fork/`，面试材料在 `code/paused/interview/`，各项目树里还有它们自己的 docs。

| 目录 | 内容 | 备注 |
| --- | --- | --- |
| `AI工具/` | AI IDE 与编码工具手册：claude/codex/cursor/gemini/pi 各自实战手册，`skills/` 使用经验，`tools/` 00-18 编码工具对照手册 | 查某工具用法先看这里 |
| `框架学习/` | 后台框架学习手册：`pure-admin/` 五个子系列（thin-js/thin-max-js/thin-max-ts/utils/max 各成册）、`ruoyi/` 运行手册 | 按框架分子目录 |
| `最佳实践/` | 代码质量方法论：Go/Python/Rust/TS-Node 四语言最佳实践审计（2026-10-10）；`Code Review/` React Code Review 体系 14 篇 + 题库 + 64 条规则速查 | |
| `环境与排障/` | 环境笔记与排障证据：`git/` 两篇、adb 排查篇、`grafana-排查日志汇总/` 2026-07-20 日志导出（Windows 环境备份快照 env-backup-2026-09-22 已于 2026-10-25 删除，git 历史可恢复） | |
| `参考资料/` | 书签 3 篇（AI 学习/聚合网站/项目开发）+ 2026 年 AI 产品技术栈选型指南 | 平铺 4 文件 |
| `项目回忆/` | 历史项目架构回忆（BCP/SOP/DOMP/MC/SCWF/SDCP/SIAM/SSAP 编号系列）、`_analysis/` commit 统计原始数据、`11-现代技术栈模板/` vite-react-admin 模板工程 | 求职与回忆用 |
| `资讯与课程/` | `AI破局俱乐部/` 课程笔记、`Lenny/` 订阅盘点、`麦田精选/` 期刊 zip 1-7 期 | |
| `skills-lock.json` | workspace skills 版本锁 | 仓根 `AGENTS.md` 引用 `web/docs/skills-lock.json` |
| `fork/` | 开源贡献台账，原 `code/fork/docs` | 代码仍在 `code/fork/` |
| `public/` | 公仓笔记，原 `repositories/public/docs` | |
| `reverse/` | 逆向指南，原 `paused/reverse/docs` | 案例仍在 `code/paused/reverse/` |

## 历史去向（迁出记录）

- AI 对话知识资产 v2 → `sessions/curated/AI对话知识资产-整理版/`（2026-10-25）
- cursor plans、项目级会话总结 → `sessions/curated/{plans-cursor,projects}/`（2026-10-25）
- gh-archive（E: 时代 gh/ 体系定性记录）、contributions（一次性统计页）→ 曾迁 `fork/docs/archive/`，同日判废删除（guahub 仓 git 历史可恢复）；magpie-ui-switchboard → `fork/hub/magpie/design/ui-switchboard-v0.2/2026-10-13-P0工作状态快照.md`（2026-10-25 终态）
- 原未整理收件箱的卡密管理、AI对话知识资产 zip 已在此前清理中移除

## 维护口径

- 新知识先落对应分类目录；无归属的先放根目录散文件，攒批后归类，不再设收件箱层。
- 会话级沉淀（对话记录、总结、plans）一律进 `web/docs/sessions/`（`md/` + `curated/`），不进本目录。
- 移动文件必须同步修相对链接。
