# Managed files 崩溃恢复与手动续跑交付合同

状态：stacked Draft。分支 `codex/managed-files-recovery-delivery`，基于 Desktop
创建入口 `9691730f4`；共同 main 基线为 `cd93f13da`。尚未作为上游最终 PR 发布。

## 主要不变量

重启后只能从同一个 durable source boundary 和 accepted Git head 继续。
已完成 Write/Edit 不重新调用工具；只有 T1、没有可验证 candidate 时必须 park。
恢复 candidate 可以重算纯内容以验证证明，但不能重新执行文件副作用或创建新 candidate。

## Owner 和原子性

| 阶段 | Owner | 权威与边界 |
| --- | --- | --- |
| existing candidate lookup | Rust helper / admission | 专用 verify 操作；缺失时返回失败，不补造 object/ref |
| terminal proof | candidate recovery owner | 从 immutable T1 args/base 重算预期内容，绑定 operation/profile/path |
| T2/successor/reservation | SQLite workspace authority | 同一个事务提交终态/推进 head/释放 reservation；exact retry |
| accepted ref | Gitoxide baseline owner | 只投影已接受证明；不是第二个 acceptance writer |
| source checkpoint | managed session owner | 绑定 source run、high-water、accepted head 及 authenticated lineage |
| continuation | Runtime / SessionManager | 新 execution identity；durable claim 仲裁，不能静默更换代码世界 |
| restart ordering | Runtime Host composition | candidate reconciliation 在 interrupted-session admission 之前 |

这里没有跨 Git/SQLite 的统一事务。candidate 是证据，RuntimeEvent 是接受事实，
accepted ref 是可重建投影。恢复步骤按持久事实幂等收敛，而非把内存程序接着运行。

## 失败状态与回滚

- T1 存在、candidate 缺失：保留 reservation，park，不重跑 Write/Edit。
- candidate ref/blob/receipt 损坏或身份不同：fail closed，不修补成成功。
- candidate 有效、T2 尚未提交：重验后原子结算；重复恢复返回原始结果。
- T2 已提交、ref 尚未完成：按同一 accepted version 修复投影，不重复 T2。
- no-op 成功与 no-effect 失败保留各自 outcome；都绑定原 baseline，不把失败伪装为成功。
- head 被其他 run 推进、lineage/检查点不匹配：拒绝 continuation，不自动 rebaseline。
- 缺 helper：不授予 managed 恢复能力，不降级到用户 checkout。
- 不执行 destructive rollback。错误不会通过删除用户数据或清空 reservation“解决”。

## 产品范围

依赖交付 3 的显式开发态 managed files 任务。重启先恢复可信事实，然后由用户 Continue
创建新 Run；本片不宣称自动无人值守 Resume、普通 Bash/npm 副作用恢复、Publish 或 GC。
正式 packaged helper admission 仍是独立发布门槛；开发 manifest 不是发布信任根。

## 平台与验证矩阵

| 平台 | 声明 | 证据范围 |
| --- | --- | --- |
| Windows | process-exit/reopen、source 不被改写、手动 continuation | 本分支独立构建；真实 helper/Host/Electron 验证记录见下 |
| Linux | 同一恢复合同 | 三平台 helper workflow 调度；本轮没有本机 Electron 证据 |
| macOS | 同一恢复合同 | 三平台 helper workflow 调度；本轮没有本机 Electron 证据 |

不承诺断电持久性，也不把指定断点 kill 等同于任意机器指令处 kill。
Windows helper suite 的六个 POSIX fixture skip 明示保留，不算跨平台已证明。
Electron smoke 是实际 preload/main/Host/SQLite/helper，只有模型采用本地 HTTP fixture。

## 提取来源

- `247b90133`、`ef1b247f5`、`4d769bf70`：source-bound continuation 和 lineage。
- `effbc1f7b`、`06f47ebdf`、`9c02dafae`：重启后 settled/unsettled 分类。
- `86d379983`、`ba8ae1c23`、`68bf194fe`、`6603389ab`：existing candidate
  lookup、完整证明、atomic settlement 与 Host 启动顺序。
- `6cdd15255` 至 `87a9c7765` 中相关测试：真实 Desktop/Host restart、
  Write/Edit/no-op/no-effect failure、重复恢复与证据阶段预算。
- 将 PR2 的缩小 fixture 扩展为完整 baseline/recovery fixture，不保留两份未使用副本。
- 不搬来源的两份旧大文档；使用四项提取账本和本合同。
- 路径级比对确认 Runtime/Host/Rust 恢复实现与冻结来源一致；
  新 main 的 UI/Host 修复、依赖版本和新的 conformance 权限测试继续保留。

## 本机验证记录

- Core、Storage、MCP、Runtime、Runtime Host、computer-use、UI、Desktop main/preload/
  overlay/renderer 独立构建通过。
- Runtime continuation + SessionManager：213/213，0 skip。
- Rust：14 unit + 63 integration 通过。
- helper artifact authority：4/4；CI workflow 选择：2/2。
- 初次 Rust 集成失败原因是测试构建覆盖静态 helper 为动态 CRT 产物，
  出现 Windows `0xC0000135`。统一 `RUSTFLAGS=-C target-feature=+crt-static`
  后 Rust 全部通过；该次受污染 Node 运行已停止，不作为产品证据。
- 真实 Electron Edit candidate/T2 中间强杀后重启、手动 Continue 已通过；
  accepted mutation 事件保持不变，source checkout 未被修改。
  证据目录：`C:/Users/wzy/AppData/Local/Temp/maka-managed-electron-oWUdpY`。
- 真实 Electron Write candidate 中断同样通过：
  `C:/Users/wzy/AppData/Local/Temp/maka-managed-electron-4xOCUF`。
- 真实 Electron 失败结果已提交后中断、Continue 通过：
  `C:/Users/wzy/AppData/Local/Temp/maka-managed-electron-08kztz`。
  上述场景均断言 accepted mutation events 不变；截图、日志、model requests 保留在临时目录。
- 真实 Electron no-op candidate 中断后恢复通过：
  `C:/Users/wzy/AppData/Local/Temp/maka-managed-electron-9BG4bQ`。
- Host helper/admission/recovery 定向完整套件：59 passed、0 failed、
  6 个 Windows 条件 skip，约 402 秒。包括实际子进程退出后的 startup settlement、
  lineage/head drift、缺失/损坏 candidate 和重复结算。
- 本分支未执行整个 monorepo CI；Linux/macOS 以及剩余 Electron 场景仍需各自执行。

复跑：构建本分支 helper 和 Desktop 后设置 `MAKA_GITOXIDE_HELPER_PATH`，
运行 `node scripts/desktop-managed-files-smoke.mjs --candidate-edit-interrupt`；
其余场景为 `--candidate-interrupt`、`--candidate-noop-interrupt`、
`--failed-before-terminal`、`--failed-result-interrupt`、
`--interrupt-turn`、`--repeat-interrupt`。各场景使用独立临时目录。
