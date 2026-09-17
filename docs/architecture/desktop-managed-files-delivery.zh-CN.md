# Desktop managed files 创建入口交付合同

状态：stacked Draft 候选。基座为交付 2 `2e8033292`，共同 main 基线
`cd93f13da`。正式上游交付前重新检查 main，不把长期 integration 历史整体提交。

## 主要不变量

用户明确选择 managed files 后，工具模式、解析后的 Session header 和 Host 能力
必须在 Session 发布及工具 T1 前固定。创建失败不能静默变成普通任务；
成功创建后 Read、Write、Edit 只消费同一 accepted Git 内容，不改 source checkout。

本片闭合的是任务创建与正常执行，不是崩溃后 continuation。

## Owner 与原子性边界

| 边界 | Owner | 保证 |
| --- | --- | --- |
| 加号菜单/首次发送 | Desktop | 显式 intent；固定 agent/default/ask；失败保留选择 |
| 已有 Host 连接 | Runtime Host client | 校验执行 capability；不匹配明确拒绝，不偷偷替换 Host |
| helper 选择 | 显式开发 bootstrap + admission | pinned bytes 校验，root election 后才延迟创建 owner |
| Session 创建 | catalog + execution stores | 稳定 request fingerprint 和 prepared header；重试不得换模型/模式 |
| source import/baseline | Gitoxide managed session owner | 绑定 source identity 与 workspace；验证持久化 import 后才发布 Session |
| 工具运行 | 交付 1/2 authority | T1/T2 与 candidate/accepted head 的既有权限边界 |

Session metadata schema 从 main 的 39 到 40，仅新增 bounded prepared header。
SQLite prepared claim、Git import、Session publication 并非一个跨系统事务；
持久化 claim/header 是重试依据，不能把未发布 import 当作可执行 Session。

## 失败与回滚

- helper 缺失、字节变化、已有 Host 缺能力：明确 unavailable；普通聊天仍可用。
- 创建中止：保留相同 request 的 prepared header；重新验证 import，不重新决定配置。
- request/source 不匹配：拒绝复用，不删除用户 source，也不自动降级模式。
- 首次发送拒绝或抛错：保留 UI intent；只有成功且该 Session 仍持有 UI 才清理选择。
- 已经发生工具 T1 后的不确定状态沿交付 1/2 fail-closed；本片不自动恢复或清除 reservation。
- 无自动 destructive rollback；残留 artifact 的长期 GC 不属于创建入口。

## 平台与发布范围

| 平台 | 本片执行语义 | 当前证据 |
| --- | --- | --- |
| Windows | 显式开发 helper；source 不变；真实 Desktop 创建/Write/Edit/Read | 本机实际 Electron smoke 通过 |
| Linux | 相同 owner 合同 | 配置三平台 helper CI；本轮未本机执行 Electron |
| macOS | 相同 owner 合同 | 配置三平台 helper CI；本轮未本机执行 Electron |

`MAKA_MANAGED_FILES_DEV_HELPER` 是开发者显式选择的 manifest，不是密码学发布身份。
packaged Desktop 不采用该开发入口；没有正式 helper admission 时保持不可用。
不宣称进程崩溃恢复、断电恢复、Bash/npm、非 Git importer、Glob/Grep 或 Publish。

## 提取与验证

行为来自来源 `7f534eeff` 的创建快照，不取后来的恢复/continuation 部分。
提取使用路径/功能块 diff；不 cherry-pick merge，不覆盖 main 的新依赖和 UI 修复。

独立安装依赖后运行仓库已有 dependency patches，再构建 Core、Storage、MCP、
Runtime、Runtime Host、computer-use、UI、Desktop main/preload/renderer；均通过。
Desktop renderer typecheck 与 build:smoke 通过，lockfile 未变。

- Desktop/UI 定向：109 passed，0 skipped。
- 创建/协议/Storage 筛选：17 passed（含 Node 文件容器计数）。
- helper bootstrap/协议完整小套件：94 passed，1 helper 条件跳过；
  随后使用真实 helper 补跑 pinned bootstrap 与 lazy startup 两项，2/2。
- readiness 筛选：6 passed，1 helper 条件跳过；相关 helper 项已单独补跑。
- Gitoxide workflow 选择回归：2/2。
- 按新增 CI step 原样执行创建/真实 helper 筛选：20 passed，0 skipped
  （含一个无名称匹配的 Node 文件容器，不等于 20 个独立创建场景）。
- 真实 Electron：从加号选择 managed，Write → Edit → Read，显示成功标志；
  source `tracked.txt` 保持 `baseline\n`。仅模型用本地 HTTP fixture，
  主进程、preload、Host、SQLite、Gitoxide 都是真实链路。

本机 Electron 证据：
`C:/Users/wzy/AppData/Local/Temp/maka-managed-electron-nIRGCN`
（截图、日志、model requests；临时目录不随 Git 提交）。
复跑入口：构建 smoke 产物后，设置 `MAKA_GITOXIDE_HELPER_PATH` 并运行
`node scripts/desktop-managed-files-smoke.mjs`。

更宽的 Host 套件存在 provider-wire、auxiliary/WorkHub 等失败并曾未退出，
尚未完成基线归因；不以定向绿灯声称全部 Host 或 CI 通过。
真实 Electron 正常路径不是 kill/restart 证据；交付 4 仍需独立提取并验证。
