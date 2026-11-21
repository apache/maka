# home/cc/guahub 仓库整合 需求澄清

> 2026-10-08 经 1 轮追问澄清 · 基线：cc/.gitignore 白名单（2026-10-08 目录整合版）+ 当日磁盘实况

## 一、已定口径

| # | 问题 | 结论 | 依据 |
|---|---|---|---|
| 1 | guahub/web 与 guahub/reverse 是否入 cc 仓库 | 不入。cc 只留各自 `README.md` 作轮廓，与 fork/interview 同款；旧索引里 Windows 老布局（根 `web/`、`reverse/`、`ggbdpq/` 共约 58k 条目）全部清出 | 用户拍板（Q1=A） |
| 2 | home「展示」cc/github 与 cc/guahub 的载体 | ~~home 白名单放行轮廓文件~~ **已推翻**：实测 git 对内嵌仓库目录下的文件 `git add` 静默无效（连 `-f` 也是，最小实验复现），该方案不成立。待定 B3 submodule（home 树显示 `cc @ 哈希` 可点入，代价：cc 提交后指针会过期）或 B4 home README 目录地图+深链（零维护，树上看不到 cc 目录） | 用户拍板 B → 实测推翻（git 内嵌仓库边界） |
| 3 | home 远端 | 配 `origin = github.com/ggbdpq/C-Users-ggbdpq`，fetch 后与本地比对；**推送策略待报告差异后另定，不擅自 force** | 用户拍板（Q3=做） |
| 4 | 独立仓库清单 | 扫描 cc 下全部 `.git`（47+，含 worktree 识别），生成机器可读清单落 `guahub/docs/`，附重扫脚本，收录新仓库后重跑 | 用户拍板（Q4=做） |
| 5 | guahub 的管理归属 | guahub 非独立仓库：共享资产（README/清单/docs/books/.agents/scripts/skills-explorer 等）由 cc 仓库跟踪，轮廓由 home 展示；fork/interview（含 code）/web/reverse 四区内容独立、外层只留 README 轮廓 | 现有实现 + 用户确认 |

## 二、待拍板

（无——2026-10-08 第二轮拍板完毕，见下）

## 二′、第二轮拍板（2026-10-08）

| # | 问题 | 结论 | 依据 |
|---|---|---|---|
| 1 | home 展示载体 | **B3 submodule**：`git submodule add` 挂 cc，home 树显示 `cc @ 哈希` 可点入 | 用户拍板（按推荐） |
| 2 | home 首推策略 | **force 推本地 main**；远端 09-30 Windows 旧快照先打 tag `archive/win-snapshot-20260930` 留档再覆盖 | 用户拍板（按推荐） |
| 3 | .githooks/pre-commit 执行位 | 未获明确指示，维持现状不启用 | 用户未表态 |

## 三、明确不做

| # | 排除项 | 原因 |
|---|---|---|
| 1 | ~~submodule 指针~~ → 视待拍板 #2 结论 | 原以维护重排除；实测轮廓文件方案不可行后，submodule 回到候选 |
| 2 | fork/interview/web/reverse 内容入 cc 或 home | 独立项目自管 git 历史是本次整合的前提 |
| 3 | 为 web/reverse 现场新建远端仓库 | 用户未要求；需要时另行发起 |
| 4 | 治理 guahub/agents、lang、tools 下独立仓库的归属 | 现状已各自独立且不在四区争议内，不动 |
| 5 | 用 plumbing（hash-object/update-index）强塞轮廓文件进 home | 与 git 内嵌仓库模型对抗，后续每次 add 都会静默丢弃改动，维护陷阱 |

## 四、开发影响面

- `cc/.gitignore`：web/reverse 改为仅放行 README；（回滚：git 管控）
- cc 索引：移除旧布局约 58k 条目，新增 guahub 各白名单区文件；一次整合提交
- `~/.gitignore`：新增 cc 轮廓放行段；home 新跟踪 5 个轮廓文件；一次整合提交
- home：新增 origin 远端 + fetch（无破坏）
- 新增 `guahub/scripts/scan-repos.sh` + `guahub/docs/独立仓库清单.md`
- 验证：两侧 `git status` 干净度、`ls-files` 计数对账、doctor/sk-sync 不受影响（cc/home 不在技能管线里，理论无涉，跑一遍确认）
