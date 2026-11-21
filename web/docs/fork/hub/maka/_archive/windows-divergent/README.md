# apache/maka 贡献实战手册

记录给 apache/maka 提 PR 过程中踩过的坑和验证过的命令（起于 2026-09-02 批量日）。下次遇到同类问题，按目录找对应文档；命令速查直接看 (../pr/commands.md)。

## 本机环境事实

| 项 | 值 |
| --- | --- |
| GitHub 账号 | `ggbdpq`（邮箱 ggbdpq@gmail.com） |
| gh CLI | 2.100.0，2026-09-04 winget 安装（`winget install --id GitHub.cli`）。旧 Git Bash 会话 PATH 不刷新，用完整路径 `C:\Program Files\GitHub CLI\gh.exe`；新终端直接敲 `gh` |
| gh 登录 | **未登录**，首次 `gh auth login` 是交互式设备码流程，需本人做（git 凭据令牌缺 `read:org`，`--with-token` 实测被拒）；登录前 git 凭据（Git Credential Manager）继续服务 push 和 API |
| 代理 | Clash 本地端口 `127.0.0.1:7897`，gh/git 只认环境变量不认系统代理 |
| fork | `ggbdpq/maka`，remote：origin=fork、upstream=apache/maka |
| fork 仓库 git 邮箱 | 本地配置 `ggbdpq@gmail.com`（全局仍是公司邮箱，未动） |
| /tmp 陷阱 | bash 重定向写 `/tmp` 可以，但 Windows 原生 Python 读 `/tmp/...` 会 FileNotFoundError——给 Python 的临时文件用 `E:/...` 路径 |

## 目录

| 文档 | 解决什么问题 |
| --- | --- |
| [01-环境搭建.md](../../handbook/01-环境搭建.md)（本目录的 Windows 分叉版 2026-11-07 删除，仅差适用范围注） | gh 安装登录、代理、git 身份（一次性初始化三合一） |
| (../guide/02-查询与同步.md) | 查 PR/CI 状态、拉日志、fork 同步、rebase/推送、workflow 拦截 |
| (../guide/03-maka机制与棘轮.md) | 架构棘轮/冻结区规则、epoch 撞号解算（maka 特有机制） |
| (../guide/04-CI排障与测试.md) | cli 测试链、平台失败排除、CI 红叉三步定性、犯错清单 |
| (../guide/05-review意见处理.md) | 拉 review 意见、修复与回复流程、评审建议的消融验证 |
| (../guide/10-maka-orca-multica对比.md) | 附录：与 orca/multica 的对比侦察记录（参考资料） |

## 本次结果（2026-09-02）

- 已合并：#4485、#4481、#4488、#4345（第一批，09-01）、#4513（09-02 10:26 UTC）。
- review 修复轮：#4518 按 Astro-Han/me2seeks 意见修文档并回复；#4506 按自动化 review 的 P1 改为 args 语义目标比对并补 3 组回归；#4517 无意见；#4514 rebase 到新 main 解除 dirty。
- 第二批 4 个（#4506 #4514 #4517 #4518）修复后 CI 全绿、open 等合并；#4514 的 CI 见 `gh pr checks 4514`。

## 学习路线（按场景索引，2026-09-13 更新）

第一次接单：pr/workflow.md（L0-L6 全流程）→ pr/commands.md（命令照抄）→ 02（同步推送）→ 04（CI 红了先定性）
第一次被 review：07（意见处理 + 回复格式）→ 03（动了 renderer 必读）
CI 红叉：09（三步定性 + 犯错清单）→ 02（拉日志）→ 04（平台失败排除）
合并/同步类问题：05（fork 同步、rebase、merge 跑步机、epoch 撞号）→ 02（连不上 GitHub）
想做文档审计：pr/workflow.md 审计轨节 → pr/journal/audit.md（11 条先例）→ README 本表
查某个坑以前踩过没有：04 犯错清单 → pr/journal/reviews.md → 单课沉淀区

## 战绩（2026-09-13）

- **已合并 26 / 在途 2（#5125 等复审、#5258 等审）/ 放弃或定性 2 / 被取代关单 1（#5116）/ 0 被拒**
- 代表作：#4815（十天九撞的结构化消息准入，reviews.md 有全程记录）、#5172（Computer Use 文档组审计）、#5125（OpenCode 会话扫描 + 两轮评审闭环）
- 无用功复盘与图表：(../pr/journal/retrospective.md)
