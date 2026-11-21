# #5507 验证纪要（车道 M5，2026-11-07，判定帖出口）

- 单：yetone/magpie#5507「面板出现未安装 agent 及未知 agent」（中文单，报告者 CrazyTomatoOo，OPEN c=0，正文仅截图）
- 截图判读：①「Pi · 未找到 CLI」行排在已接入区中间（无详情/模型/开关的 gone 行）；②「未设置」区有 `omp · lane`/`omp · lane2`（放大截图确认分隔符是间隔号·，非短横线）
- 处置：**判定帖出口**——两个现象均为设计内行为，无可修 bug
- take 帖 6695396422；判定帖 6695430084（GET 回读 OK，len 1347，全要素在）
- worktree /private/tmp/mg-5507（分支 fix/5507-unknown-agents，基线 30a0bfe88；无代码改动，无提交，无 push）

## 判定一：pi「未找到 CLI」gone 行

- 机制：`CLIMissing()`（internal/agent/install.go:280）——配置目录在（~/.pi）+ CLI 不在 PATH + 无桌面 app/编辑器扩展共读（cliHeld，codex/claude/gemini/opencode/cline/goose 名单）=「卸载残留」
- 设计史链：#843（~/.dsh）→ #2177（~/.claude）→ #2173（~/.hermes/config.yaml），api.go:253 注释与 app.js:668-681 的 gone 行渲染（`row.classList.add("gone")`、无设置、panel 模式 hover 有 goneSaid 解释、「安装其他 Agent」提供重装）均为既定产品决策
- 报告者「没安装 pi」与判定不矛盾：magpie 判的是「配置在而 CLI 不在」（装过又卸/工具建的 ~/.pi 残留）
- 分区语义：已接入区=「接入过 magpie 的」，非「已安装的」；gone 行留原位去设置是 #2177 的形状

## 判定二：omp · lane / omp · lane2

- 机制：`ompProfiles`（internal/agent/omp.go:157）列 `~/.omp/profiles/<name>`，命名 `"omp · "+name`，命名规则照抄 omp 的 pi-utils dirs.ts（ompProfileName/ompReserved 正则）
- **lane 是 omp（oh-my-pi）官方的并行会话/worker 概念**（Omp Fleet 用法 4–20 条并发泳道）；报告者机器的 lane/lane2 是其 omp 18.17.0 建的 profile 目录——不是未知 agent，是用户自己的 omp
- Web 佐证：skillsdirectory.com/skills/avenoxai-omp-fleet（lanes=concurrent agent sessions）、github.com/can1357/oh-my-pi docs/providers.md

## 可操作出口（判定帖已给出）

- pi：Agents 页「管理」（openAgentsManager，覆盖全部 agent 含 gone/profile 行）→ 搜 pi → Hide selected（只藏行不动配置，settings.agentsHidden）；或删 ~/.pi 根除；「安装其他 Agent」可重装
- omp lanes：「管理」隐藏；或在 omp 里清 lane/删 ~/.omp/profiles/lane、lane2 目录

## 环境清理

无代码改动/无 fork push；临时截图与正文临时文件已删；产物目录落判定帖正文+原报告截图（缩放版）。
