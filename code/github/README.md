# github —— 第三方仓库收藏清单

> 根目录 `E:\cc\github`。**逐仓明细在 [项目清单.md](项目清单.md)**：上游、分支、本地最后提交、远程状态、一句话说明都在那里。
> 本文件只保留四件事：现状统计、不可再下载清单、目录约定、变更记录。

## 现状（2026-10-18）

| 分组 | 仓数 | 说明 |
|---|---|---|
| `agents/` | 26 | AI/Agent 学习、评测 harness、coding agent |
| `other/` | 66 | 杂项 10 + `kuaibiancheng` 56（培训班学员仓合集，上游全在线） |
| `wechat/` | 21 | 微信解密 / 备份 / 分析 / AI 记忆 |
| `register/` | 15 | 账号注册与凭据自动化 |
| `social/` | 11 | B 站 / X / 语雀等平台工具 |
| `tools/` | 8 | 逆向、SQL、求职、硬件联动 |
| `skills/` | 6 | Claude Code 技能包与 PPT 技能 |
| `paid/` | 5 | pure-admin 付费源码（已购授权，勿外传） |
| `ui/` | 3 | 前端 / UI 参考 |
| `interview/` | 1 | 求职工具 |
| **合计** | **162** | 约 22.3 GB（含各仓 `.git`） |

远程状态口径：**在线** 151 个（其中 gitee 源 3 个，能拉最新）、**远程已删** 5 个（只能以本地副本为准）、私有仓 6 个（需授权）。

## 永久跳过清单（远程已删，不可再下载）

> 上游删了就不会再有，本机副本是唯一来源，**不要删**。

| 上游 | 本地路径 | 状态 |
|---|---|---|
| `ILoveBingLu/CipherTalk` | `wechat/CipherTalk` | Repository not found（2026-09-25 确认） |
| `LOGO127/wechat-ai-memory` | `wechat/LOGO127-wechat-ai-memory` | Repository not found（2026-09-25） |
| `yoruuuchan/open-kimi-ppt-skill` | `skills/yoruuuchan-open-kimi-ppt-skill` | Repository not found（2026-09-25） |
| `afumu/wetrace` | `wechat/wetrace` | DMCA 下架（2026-09-25） |
| `ylytdeng/wechat-decrypt` | `wechat/wechat-decrypt` | DMCA 下架（2026-09-25） |
| `Binaryify/open-kimi-ppt-skill` | `skills/binaryify-open-kimi-ppt-skill` | 上游在线但内容已被作者清空（只剩 1 个 `Clear repository due to copyright reasons.` 提交） |

**风险点**：`wechat/wetrace`、`wechat/wechat-decrypt`、`skills/yoruuuchan-open-kimi-ppt-skill` 这三份在三端都只剩本机这一份（mac 已清理、win10 已退役）。建议定期 `git bundle --all` 一份到异地。

## 目录约定

- 分类：`<用途>/<仓名>`，仓名默认裸名；同组撞名（Windows 下仅大小写之差也算重复）用 `<owner>-<仓名>`，如 `wechat/airen3339-py_wx_key`、`wechat/LOGO127-wechat-ai-memory`。
- **按用途分层，不按状态分层**：上游已删的仓也放进它该在的分类（`wechat/`、`skills/`），状态由 `项目清单.md` 的「状态」列和上面的永久跳过清单体现。
- `other/` 是杂项状态目录，自动更新脚本整体跳过；其余分组是否自动更新由 [repos.tsv](../../web/scripts/github/repos.tsv) 决定。
- 活跃开发、经常改动的 fork 不放这里，见 [../fork/](../fork/)。
- `paid/` 付费源码勿公开。
- 新增仓：克隆到 `<用途>/<仓名>` → 在 `项目清单.md` 对应分组加一行 → 在下面变更记录补一条。

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-18 | 三端收敛：mac 清理 67 个后把 30 个保留仓并入本机；win10 收尾补 2 个（`other/ggbdpq/pi-web-dev`、`wechat/berlinwu-wx_key`）；撤销 `_archive/`，5 个仓按类型并入 `wechat/` 与 `skills/`；删除重复克隆 `skills/open-ppt-skill`（与 `skills/open-kimi-ppt-skill` 的 HEAD 及 459 个文件完全一致）；台账由 xlsx 改为 `项目清单.md`，本机 131 → 162 仓 |
| 2026-10-13 | 跨机目录占位：Mac 侧 122 个项目目录以 `.gitkeep` 入库；fork 收编 agent-coding-baseline、autonomous-pentest-agent、ARTIFEX、workbuddy2api-panel |
| 2026-10-11 | fork 收编 minimax-code、opencode、claudia、quota-bar、bifrost、litellm-docs、LiveAgent、cc-switch-website、Ydisks-Xianyu-Helper、RuoYi、WeChatBridge（均零独有提交，fork 已删） |
| 2026-10-12 | `_archive/` 收编 wechat/（CipherTalk、LOGO127-wechat-ai-memory） |
| 2026-10-09 | 批量克隆还原 91 项；确认 5 个上游远程失效进入永久跳过清单 |
| 2026-09-29 | 新机迁移，`other/` 下若干无 `.git` 收藏暂缺 |
