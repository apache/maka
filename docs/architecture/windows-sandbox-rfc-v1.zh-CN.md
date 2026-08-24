<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Windows 沙箱后端 RFC v1

- 状态：实现基线已选定；首个预览切片（[#2961](https://github.com/maka-agent/maka-agent/pull/2961)）已于 2026-08-17 合并；产品接入继续做发布验证（预览范围见 §6.5）
- 跟踪：[Issue #2142](https://github.com/maka-agent/maka-agent/issues/2142) Windows Phase 4
- 更新日期：2026-08-18
- Owner：`@maka/runtime` sandbox boundary 与 Runtime Host execution composition
- 英文版：[windows-sandbox-rfc-v1.md](./windows-sandbox-rfc-v1.md)

## 1. 范围与设计状态

本文定义 Windows 沙箱的威胁模型、选定的原生架构、替代方案、交付切片与发布证据，是 Phase 4 的完整
安全基线。首个产品实现位于 #2961；是否宣布更广泛的 Windows 支持，仍由 #2142 和下文发布 gate 决定。

W0 选择 Maka 自有 Rust 实现，不直接引入其他产品的 setup 和协议模型。Windows 2025 证据否决了当前用户
restricted-token 候选：真实 `cmd.exe` 和 launcher child 无法稳定初始化；同一 runner 上的 AppContainer 则在
无需提权的情况下证明了默认拒绝、允许目录访问、网络拒绝和原子 Job membership。

首个切片为每次启动使用 request-derived 独立 AppContainer SID、带持久 one-shot ledger 的 ACL grant，以及
不授予网络 capability 的 AppContainer token。下一次启动前会 reconcile 遗留 grant，但不会复用旧 identity。
它不宣称抵抗管理员、已攻陷的同用户 host
process、任意断电，或第 10 节列出的全部路径攻击。

## 2. 调研依据

本设计在 2026-08-13 对照了一手资料。仓库证据固定到已审查 commit，避免上游后续变化悄悄改写论据。

这是代表性调研，不是声称穷尽所有项目。选择标准是：已经交付面向 Agent 的原生 Windows 沙箱（Codex、
Gemini CLI）、拥有成熟 Windows 进程沙箱（Chromium），或明确公开主流 Agent 的 Windows 隔离边界
（Claude Code、OpenCode）。没有公开实现或明确 Windows 合同的项目不作为实现证据。架构冻结前如果出现
实质更强且持续维护的实现，W0 必须重新对比。

| 来源 | 审查证据 | Maka 借鉴内容 | Maka 不做的假设 |
| --- | --- | --- | --- |
| Microsoft Windows API | AppContainer、restricted token、process attribute、Job Object、Windows Sandbox、WSL2 | 内核机制及官方边界 | API 存在不等于能力可用 |
| OpenAI Codex `902bd9e06b3e` | `windows-sandbox-rs`、setup、ACL state、private desktop、restricted token、Job、firewall/WFP、smoke test | 最接近 Agent 场景的参考：offline/online identity、持久状态 reconcile、显式 handle/job、fail-closed policy check | 可以直接复用源码、合同完全等价或未审代码必然正确 |
| Gemini CLI `1ac337739586` | `WindowsSandboxManager.ts`、`GeminiSandbox.cs`、sandbox 文档 | 环境清理、restricted-token launch、suspended Job assignment、明确披露 low-integrity label 持久化 | 其网络 throttle 或 best-effort ACL 足以满足 Maka |
| Chromium `024a2d21125b` | Windows broker/target、restricted token、Job、alternate desktop、integrity、mitigation、AppContainer | 分层防御、broker 边界、private desktop、handle allowlist、process mitigation | renderer policy 可原样复制给任意开发工具 |
| Claude Code 官方文档与 `992381936817` 示例 | filesystem/network 双边界、proxy、升级请求；Windows 使用 WSL2 | 文件与网络分别证明，不能从通用配置推导原生支持 | 闭源实现细节 |
| OpenCode `cc4b45612974` | 官方 Windows 文档推荐 WSL | WSL 可作为显式外部环境 | WSL 就是 Maka 原生 Windows backend |

Codex、Gemini 和 Chromium 直接影响了分层 broker、Job、ACL recovery 与 fail-closed 合同，但 Maka 没有复制
它们的产品协议。最终由可执行证据推翻初始专用账户建议：首个 native backend 选择 AppContainer，专用
restricted-token 候选则保留为负面证据。

## 3. 决策

Maka 打包一个小型原生 Rust broker/client。Runtime Host 把 `PermissionProfile` 编译为封闭 launch manifest，
然后启动 one-shot broker。可信原生进程把请求绑定到内核返回的 pipe client PID、一次性 nonce 和完整 launch
policy 的 SHA-256，再叠加以下 Windows 控制：

- 不授予网络 capability 的 AppContainer primary token；
- 通过 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在创建时原子附加、close 时杀整棵树的 Job Object；
- 禁止 handle inheritance；
- 只给编译后的 read/write root 添加 AppContainer ACE，并使用持久 recovery ledger；
- ACL 修改前递归拒绝 reparse point；
- 从规范化 command 构造封闭、排序后的环境；
- 只允许 SYSTEM 和当前用户的本地命名管道，以及有长度上限的 frame。

x64 backend 只在打包 native resource 存在时注册。binary 缺失、路径无效、profile 不支持、manifest 错误、
ACL recovery 失败或 launch 失败都保持 typed fail closed，绝不 unsandboxed retry。filesystem worker 与 Agent
command 通过既有 `SandboxManager` 链路共用此 backend。

Windows Sandbox 与 WSL2 后续可以成为显式 external profile，但不能替代 native per-command backend。
AppContainer 单独使用也不够；Job、ACL policy、recovery ledger、broker authorization 和 Runtime fail-closed
接入共同构成边界。

## 4. Maka 现有合同

平台无关 authority 仍是 `PermissionProfile` 和 active session `ExecutionBoundary`。Windows 消费与 macOS
Seatbelt、Linux bubblewrap 相同的规范化 command/path context，不引入第二套权限语言。

- `SandboxManager` 负责选择 backend 与变换 command，绝不 unsandboxed retry；
- caller 负责 canonical cwd、workspace/runtime roots 与 boundary expansion approval；
- backend 负责 profile compilation、enforceability check 和 typed launch request；
- process runner 负责 launch、cancel、output 与 lifecycle settlement；
- Runtime Host 负责 composition，backend 不可用时拒绝 managed I/O。

Windows 不能被诚实地表达为 argv wrapper。token、logon identity、handle filter、private desktop 和原子 Job
assignment 需要在 `SandboxExecRequest` 中新增 typed native launch request。

## 5. 威胁模型

攻击者控制 command arguments、脚本、子进程、允许 root 内的文件内容，以及 sandbox helper 解析的数据。
受保护资产包括：

- 允许 root 外文件与 writable root 内 protected metadata；
- host credential、环境秘密、registry、DPAPI material 和用户 profile；
- host network、loopback service、SMB/UNC 与继承 socket；
- sandbox 外进程、窗口、handle、device 与 IPC object；
- Maka sandbox setup record、ACL ownership ledger、可执行文件与 broker protocol。

Windows kernel、签名 Maka binary、Runtime Host 和父 user session 被信任。边界不抵御管理员、内核失陷或
Maka 外已失陷的同用户进程。sandboxed code 从第一条指令开始按恶意代码处理。

路径一律按敌对输入处理：reparse point、junction、symlink、hard link、ADS、device path、UNC、大小写别名、
8.3 name、mount point 与 replacement race 都不能扩大权限。字符串前缀绝不是授权证据。

## 6. 必须保证

### 6.1 文件系统

- 默认拒绝：不得读写 exact profile 未允许的 root；
- read/write grant 保持分离；
- `.git`、`.agents`、`.codex` deny-write 覆盖所有嵌套位置，除非平台无关合同有 exact override；
- runtime/executable root 最小化且只读；
- 每次调用的 temp 只有在进程树 drain 后才能移除；
- 对 NTFS/ReFS 做 capability probe；不能兑现 descriptor 合同的文件系统 fail closed，FAT 不支持 restricted；
- Maka-owned ACL 归属于每次 launch 的独立 SID，在版本化 state file 中记录实际 exact/recursive grant mode，
  并在 startup reconcile；
- setup、升级、卸载、profile 变化不得留下未知可用 grant；ownership state 损坏或缺失时 readiness fail，
  禁止猜测 ACE；
- 路径存在 reparse point 时同时考虑 lexical alias 与 canonical target。

### 6.2 网络

- `network.restricted` 不能创建 inbound/outbound channel；
- 覆盖 TCP、UDP、DNS、loopback、listener、SMB/UNC 与 inherited socket；
- named pipe 默认拒绝；打包 one-shot 路径在进程内完成 authorization，独立实验 pipe 的 DACL 仅允许选定
  sandbox principal 与 broker；
- Windows 报告 local firewall policy 无效、部分生效或被 group policy 覆盖时，offline backend 不可用；
- 未来 domain allowlist 必须走 Maka-owned proxy，不把 DNS 结果编译成持久 direct-address allowlist。

### 6.3 进程、desktop、handle 与环境

- child 通过 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在创建时进入 Job，不存在可运行的 pre-assignment window；
- Job owner close 时杀死所有 descendant，禁止 breakaway；
- 仅通过 `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 继承声明的 stdio/protocol handle；
- 非交互 worker 以 launcher 创建的 private (alternate) desktop 作为初始桌面，绝不落在交互 `Default` 桌面上；要让 worker 在进程内逃逸尝试之后仍然*不能*枚举、发消息或钩住用户交互窗口，还需要暂缓的 no-Win32k/window-station 门禁（§6.5）； _(按初始桌面**放置(placement)**强制，而非防逃逸 confinement：每次启动与 readiness probe 均创建按启动的 alternate desktop，其 DACL 仅授予发起用户、Local System 与该次启动的 AppContainer SID；只给该 SID 最小非交互权限，并以前置 deny ACE 从发起用户 SID 上剥离 `DESKTOP_SWITCHDESKTOP`、`DESKTOP_HOOKCONTROL` 与 journal 录制/回放权限——因为 AppContainer 子进程的 token 仍有效携带该用户 SID，否则 owner 的全控 allow ACE 会把子进程列为这些权限的被授予者。子进程以 `STARTUPINFOW.lpDesktop` 指向它启动，桌面建不出或 SID 授不了即 fail closed。由于 `lpDesktop` 只选择*初始*桌面,这把 worker 放置到交互 `Default` 桌面之外并对私有桌面做 DACL 保护,但这是 placement 加 DACL 保护、**不是**防逃逸边界 —— 没有任何结构性机制阻止进程内代码调用 `OpenDesktopW("Default")` + `SetThreadDesktop` 重新挂回,且 clipboard 归 window station、两个桌面仍共用同一 window station 故不被隔离。该桌面带显式 Low no-write-up mandatory label（`S:(ML;;NW;;;LW)`）,使 DACL 授予的 create-window/write 权限能通过 MIC 供 Low-IL AppContainer 子进程使用,且桌面 heap 经 `CreateDesktopExW` 按启动限额,受支持的十路并发对系统 desktop-heap 上限保有一个数量级余量。防逃逸边界(no-Win32k mitigation、带独立 window station 的 clipboard 隔离,以及端到端证明授予权限的 child 侧 window-creation 检查)均为后续硬化门禁 —— 见 §6.5。)_
- token 移除 privilege 并使用 restricting SID；low integrity 只是 defense in depth，不是文件策略；
- child 只接收 allowlist 环境，不隐式继承 credential、token、proxy、shell startup hook、用户 PATH 或 loader
  injection variable；
- 禁止 elevation、service、scheduled task、非 allowlist COM、shell association、debugger、父 token/handle；
- W2 前逐项选择并兼容性验证 process mitigation，覆盖 Node、PowerShell、cmd、Git 与 packaged Electron resource。

### 6.4 能力与失败

- readiness 必须在生产 identity/token/Job/desktop/handle/filesystem/offline network 下启动真实 probe； _(已实现:预览版的 `--readiness-probe` 会真正建立 AppContainer identity/token、kill-on-close Job 与按启动的 private desktop,并在该桌面上启动一个抛弃式受限子进程,宿主无法创建或强制边界时 fail closed,而非仅凭二进制存在即注册;完整的按 profile filesystem 策略与 offline network 策略尚未在 readiness 阶段演练 —— 见 §6.5。)_
- readiness probe 的抛弃式 profile 生命周期必须隔离且 fail closed； _(已实现:probe profile 位于专属 `maka.readiness.` 命名空间,与生产 `maka.sandbox.` 命名空间结构性不相交,其保留的 `requestId` 被 launch validation 拒绝,任何生产启动都无法解析到 probe 删除并重建的那个 profile;整个 delete→create→probe→settle→drop 生命周期由一个 DACL 加固的按用户命名互斥量跨进程串行——与 ACL ledger 复用同一原语——使并发 probe 不会互删对方的 active 注册;当 probe 无法证明其 Job 清空时按该周期 fail closed(报告不可用),固定的 readiness identity 并不被持久隔离——清理依赖 kill-on-close Job 的整树终止,且因该 probe 不授任何 filesystem root,一个假设存活的子进程也继承不到任何 ACE 权限;消费侧对负可用性结果只按有界 TTL 缓存,以限制一次瞬时失败毒化 module 缓存的时长:由**下一次 composition 构建**重探,而非运行中的宿主原地恢复——filesystem worker 在 composition 构建时一次性发布,故一个已判负的宿主只在新 composition 或 Runtime Host 重启时恢复,正结果则按进程生命周期缓存。未证清空 identity 的持久隔离,以及运行中宿主的主动 readiness 恢复,均为后续门禁——见 §6.5。)_
- launcher signature/version/digest 必须与 package metadata 一致； _(后续门禁：每次启动的 request digest 目前已在 broker 内重算并强制；对照打包 metadata 校验 launcher 二进制的 signature 与 version 随 Phase 3 签名一并暂缓 —— 见 §6.5。)_
- setup 缺失、identity drift、ACL state 损坏、网络策略无效、文件系统不支持、helper 不匹配、probe 失败都返回
  stable typed unavailable reason； _(后续门禁:readiness probe 目前把每种失败收敛为单一 fail-closed 布尔,统一以
  `backend_not_available` 呈现;结构化 typed reason 尚未实现,暂缓 —— 见 §6.5。)_
- restricted managed profile 在 `auto`/`require` 下绝不 fallback host execution；
- diagnostics 只暴露 backend、setup version 与 failure stage，不暴露 path、SID、credential、env 或 firewall detail。 _(后续门禁:probe 以 `stdio: 'ignore'` 运行且只保留退出结果,setup version 与 failure stage 尚未传播,与结构化 unavailable reason 一并暂缓 —— 见 §6.5。)_

### 6.5 预览实现状态（2026-08-17）

首个预览切片 [#2961](https://github.com/maka-agent/maka-agent/pull/2961) 已于 2026-08-17 合并，强制上述保证的一个子集。本节把文档与已交付代码对齐，使 RFC 不 overclaim：§6.3/§6.4 中尚未强制的保证在此显式标为后续门禁。标注 `(#3161)` 的条目落在 readiness-probe 后续 PR，而非已合并的 #2961 切片；其余条目由 #2961 当前强制。

**已强制（未标注者由 #2961 合并强制）：**

- 默认拒绝文件系统，读/写 grant 分离（§6.1）；
- ACL 修改前拒绝 reparse point 与多硬链接对象（§5/§6.1）；
- 每次启动使用 request-derived 独立 AppContainer SID + 版本化 ledger + startup reconcile（§6.1/§7.1）；
- 不授予网络 capability 的 AppContainer token（§6.2）；
- 创建时原子附加、close 时杀整棵树的 kill-on-close Job（§6.3）；
- 仅通过 `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 继承声明的 handle（§6.3）；
- 封闭、排序后的 allowlist 环境（§6.3）；
- 按启动的 private desktop **放置(placement)**（§6.3）**(#3174)**:每次生产启动与 readiness probe 均在当前 window station 上创建 alternate desktop,其 DACL 仅授予发起用户、Local System 与该次启动的 AppContainer SID(且只给该 SID 最小非交互权限;并以前置 deny ACE 从 AppContainer 子进程有效携带的发起用户 SID 上剥离 `DESKTOP_SWITCHDESKTOP`/`DESKTOP_HOOKCONTROL`/journal 录制回放),并以 `STARTUPINFOW.lpDesktop` 指向它启动子进程,建不出或授不了即 fail closed。桌面钉在 Low integrity（`S:(ML;;NW;;;LW)`）使授予权限对 Low-IL 子进程通过 MIC,且 heap 经 `CreateDesktopExW` 按启动限额（512 KiB）使受支持并发不会耗尽系统 desktop heap。由于 `lpDesktop` 只选择*初始*桌面,这把 worker 放置到交互 `Default` 桌面之外并对私有桌面做 DACL 保护;这是 placement 加 DACL 保护、**不是**防逃逸边界——没有结构性机制阻止进程内代码 `OpenDesktopW("Default")` + `SetThreadDesktop` 重新挂回,clipboard 也归 window station、仍为共用(no-Win32k mitigation、独立 window station 与 token 边界见下方暂缓门禁);
- 生产 identity readiness probe（§6.4）**(#3161)**:`--readiness-probe` 真正建立 AppContainer identity/token、kill-on-close Job 与 private desktop 并在该桌面上启动抛弃式受限子进程（`cmd.exe /d /c exit 0`,以 `/d` 关闭 AutoRun 使宿主 shell 定制不能扭曲结果）,使可用性在宿主无法创建边界时 fail closed,而非仅凭打包二进制存在;成功时输出机器可读 attestation（精确 SID 匹配、特定 Job membership、settlement、private-desktop placement）,发布冒烟逐字段断言,使该 gate 不会静默退化为空洞的 exit-0 检查;
- 专属且跨进程串行的 readiness profile 生命周期（§6.4）**(#3161)**:probe profile 位于与生产不相交的命名空间,其保留 `requestId` 被 validation 拒绝,一个 DACL 加固的按用户命名互斥量串行其 delete→create→probe→drop 生命周期,未证清空的 probe 按周期 fail closed 而非宣称边界干净(清理依赖 kill-on-close Job 与零权限 identity,而非持久隔离),负可用性按有界 TTL 缓存以限制一次瞬时失败毒化 module 缓存的时长——由下一次 composition 构建重探,而非运行中宿主原地恢复;
- fail-closed capability check，绝不 unsandboxed fallback（§6.4）。

**已设计但作为后续门禁暂缓（预览切片尚未强制）：**

- 完整 window station 分离与 clipboard 隔离（§6.3）:worker 已运行在私有 alternate desktop 上,但该桌面仍位于 launcher 的 window station 上。由于 clipboard 归 window station 所有,alternate desktop 并不隔离它;迁移到独立 window station(从而隔离 clipboard)为后续硬化门禁;
- 防逃逸桌面 confinement:no-Win32k mitigation、token 边界与可用的 Low-IL 桌面权限（§6.3）:`STARTUPINFOW.lpDesktop` 只选择初始桌面,故在没有 no-Win32k process mitigation(或独立 window station/token 边界)时,进程内代码可 `OpenDesktopW("Default")` + `SetThreadDesktop` 重新挂回交互桌面;当前落地契约仅为初始桌面 placement 加 DACL 保护,而非结构性 confinement。另外,该桌面现已带显式 Low no-write-up mandatory label,使 AppContainer SID 的 create-window/write 授权能通过 MIC,但没有任何 probe 在 child 内实际创建窗口,故这些权限只是"标签可用"而非端到端证明。强制 no-Win32k mitigation 与 child 侧 window-creation 测试,均暂缓;
- readiness 阶段的完整策略覆盖（§6.4):readiness probe 已建立生产 AppContainer identity/token、kill-on-close Job 与 private desktop 并在其上启动受限子进程,但尚未在 readiness 阶段编译并演练按 profile 的精确 filesystem 根与 offline network 策略 —— 这些目前按每次启动强制,而非在 readiness 阶段复证;
- 随 Phase 3 签名一并落地的 launcher signature/version 校验（§6.4）。
- 结构化 unavailable reason 与 diagnostics（§6.4）:readiness probe 以单一 fail-closed 布尔(呈现为
  `backend_not_available`)收敛所有失败;stable typed unavailable reason 与 setup-version/failure-stage
  诊断已设计但尚未实现或传播。
- readiness 的跨进程并发真机竞态覆盖（§6.4）:readiness profile 生命周期已由命名互斥量串行,并有针对
  互斥量名、命名空间与 validation 原语的单元测试;在真实 Windows 宿主上 spawn 多个并发 probe 的多进程
  竞态测试暂缓——对一个抛弃式诊断探针不成比例且在 CI 中天然 flaky。被强制的契约是串行化原语本身,而非
  端到端竞态 harness。
- 未证清空的 readiness identity 的持久隔离（§6.4）:probe 无法证明其 Job 清空时按该周期 fail closed,下一次 probe 在锁下删除并重建那个固定 identity。残余风险有界——readiness 子进程是被授零 filesystem root 的 `cmd.exe /c exit 0`,一个假设存活的子进程既不 spawn 任何东西也继承不到任何 ACE 权限,且 kill-on-close Job 会终止整树——但该 identity 未被持久隔离。持久隔离(或每次 probe 用唯一 identity 加 orphan/对账 ledger)暂缓。
- 运行中宿主的主动 readiness 恢复（§6.4）:负可用性结果由 TTL 限时,使其不会长时间毒化 module 缓存,并由**下一次 composition 构建**重探。运行中的 Runtime Host 不会主动重探或热发布 filesystem worker——worker 在候选构建时一次性组装——故已判负的运行中宿主对瞬时负结果的恢复被限定到新 composition 构建或重启。带动态 worker 发布的主动 readiness 重试暂缓。

暂缓收窄的是 readiness 丰富度与 desktop 层的 defense-in-depth，而非强制边界本身：backend 不可用、identity drift 或启动失败仍然 fail closed，受限 managed profile 也绝不回退到宿主执行。

## 7. 选定架构

```mermaid
sequenceDiagram
  participant H as Runtime Host
  participant M as SandboxManager
  participant B as one-shot native broker
  participant J as Job Object
  participant C as AppContainer worker

  H->>M: transform(profile, canonical path context)
  M->>M: compile roots, environment, network policy
  M-->>H: native path + one-shot manifest
  H->>B: --broker-local manifest
  B->>B: delete manifest; bind PID, nonce, launch digest
  B->>B: recover ledger; reject reparse tree; grant SID ACE
  B->>J: create kill-on-close Job
  B->>C: create AppContainer process with atomic Job attribute
  C-->>B: bounded exit result
  B->>B: remove owned ACE and completed ledger
  B-->>H: exit code or fail-closed error
```

### 7.1 Setup 与持久状态

首个实现不需要 elevated setup。Windows 为每次 launch 创建 request-derived Maka AppContainer profile，打包
native binary 只给当前 launch 允许的 root 授予其独立 SID。修改前递归拒绝 `FILE_ATTRIBUTE_REPARSE_POINT`，用 `create_new` 和
`sync_all` 持久化版本化 ledger，并在接收新请求前 reconcile 全部遗留 ledger。正常结束先移除 SID ACE，再
删除 ledger。全局 kernel mutex 只覆盖 ledger/ACL 修改；每个 launch 在 child settlement 完成前持有独立的
request-specific kernel lease，因此 recovery 会跳过仍在使用的 ledger，同时不同 launch 仍可并发执行。

ledger 文件名使用 request identity 的 SHA-256，请求控制的路径字符无法逃出目录。`icacls.exe` 从绝对
`%SystemRoot%\System32` 解析，不经过 shell，并使用 `/L` 操作 link object 而非跟随目标。Windows CI smoke
证明正常清理、遗留 ledger recovery 和允许目录内 junction 拒绝。crash/power-loss 与并发替换加固仍是发布
证据，不能当作已满足的假设。

### 7.2 Broker 与协议

native component 不是常驻 privileged service。打包的 `--broker-local` 路径消费并删除一个 manifest，绑定
当前内核 PID，在进程内完成 authorization，并在 AppContainer process 结束和 ACL 恢复后退出。独立 named-pipe
模式只保留为 transport evidence，产品路径不再经过它。

authorization 从完整 canonical launch object 重算 digest，所以修改
executable、arguments、cwd、roots、network 或 environment 都会使批准失效。未知 field/version/outcome 或超长
frame 一律 fail closed；授权路径只能调用 AppContainer atomic launcher。

## 8. 替代方案与项目对比

| 方案 | 证据 | 决策 |
| --- | --- | --- |
| 专用 identity + restricted token + Job + private desktop + ACL ledger + WFP/firewall | Codex 已展示 Agent 场景的 setup 与对抗测试形态 | 未来更强 tier 的参考；Maka runner 证据显示该候选无法可靠初始化真实 child |
| AppContainer + atomic Job + one-shot broker + ACL ledger | Microsoft/Chromium 说明基础机制；Maka Windows 2025 CI 证明组合边界 | 选定 native backend |
| 当前用户 restricted token + Job | 有效进程加固 | 拒绝：当前用户既有 ACL 仍可读，且 prototype 初始化不可靠 |
| Low integrity ACL + Job | Gemini 实现了轻量路径 | 不用于 Maka strong tier：持久 label、best-effort ACL、network throttle 不满足 fail closed |
| Chromium sandbox library | 成熟 broker/target、hook、mitigation、AppContainer | 仅参考：大型 C++ 集成和 renderer 假设不适合 one-shot 任意工具 |
| Windows Sandbox | 强 VM 边界 | 未来 external profile；可选组件且 per-command 生命周期粗重 |
| WSL2 | Claude Code/OpenCode 用于 Windows workflow | 未来 external profile，不是 native Windows 语义 |
| Docker/Hyper-V container | 环境具备时边界更强 | 可选 external profile，不作为通用 native 前置条件 |

## 9. 交付计划与 Gate

### W0：可行性与冻结实现规格

- [x] 建立可复现 MSVC CI 的 Maka 自有 Rust launcher；
- [x] 用真实 child 证据比较 restricted-token 与 AppContainer identity；
- [x] 证明原子 Job、无 handle inheritance 和真实 loopback 拒绝；
- [x] 定义封闭 broker、launch 和 ACL-ledger schema；
- [x] 选择 AppContainer 并记录被否决候选；
- [x] 用最终时序和失败边界更新 RFC。

### W1：managed 只读 filesystem worker

- [x] 从 `PermissionProfile` 编译允许 root 与 runtime/executable root；
- [x] 用 AppContainer 拒绝 ambient filesystem 与 network；
- [x] 把 capability detection 接入 Runtime Host managed execution；
- [x] 打包并验证 x64 native resource；
- [x] resource/capability 不可用时 fail closed；
- [ ] 完成 cancel、parent-death、并发和残留状态发布测试。

这是第一个用户可见沙箱里程碑。未勾选证据限制支持声明，但绝不允许 unsandboxed fallback。

### W2：workspace-write 与通用命令

- 强制 write root 与嵌套 protected metadata；
- 不依赖 ambient PATH/startup script 做 exact executable discovery；
- 证明 PowerShell、cmd、Git、native exe、ConPTY 与 descendant；
- 集成 setup、upgrade、rollback、uninstall 与 signed packaging；
- 保留 path-free run-trace enforcement evidence。

### W3：对抗审查与支持声明

- 在所有支持的 Windows/filesystem 上运行 release-blocking matrix；
- 完成独立安全审查并修复全部 high/critical；
- 文档化不支持环境与恢复方法；
- 只有此后才勾选 Phase 4 或宣称 Windows restricted profile 受支持。

## 10. 必需发布证据

Windows sandbox job 必须运行真实 child-process 正反测试：

- allowed root read/write，以及 outside/read-only/protected metadata deny；
- junction、symlink、mount、hard link、8.3、case alias、ADS、UNC、device path、replacement race；
- TCP/UDP/DNS/loopback/listener/SMB/named pipe/inherited socket；
- child/grandchild、detached、breakaway、shell association、COM、scheduled task、service；
- env、registry、credential store、DPAPI、parent process/token、clipboard、user profile；
- normal exit、timeout、cancel、launcher crash、Runtime Host crash、desktop crash、reboot；
- disjoint identity/root 的并发 sandbox；
- 每个持久 setup、ACL、firewall/WFP、marker publication failpoint；
- installer/upgrade/uninstall 对 exact signed launcher 与完整状态清理的验证。

只检查生成 flag 的 unit test 不是安全证据。绿色测试必须证明真实 child 的禁止操作失败，且没有残留进程或未知
durable authorization。

## 11. 工期与完成标准

单名有经验工程师在 RFC review 后的估算：

- W0：1-2 周；
- W1：2-3 周；
- W2：3-5 周；
- W3 与整改：1-2 周。

Phase 4 的现实区间是 7-12 周，不含外部审查排期。两名工程师可并行 native setup/launcher 与 Runtime/test
harness，但安全审查和架构 gate 仍是串行。若 W0 证明 Codex 形态和打包链可行，只读 W1 约 3-5 周可交付。

只有 W0-W3 证据成为 release-blocking、setup/uninstall 能干净恢复、restricted profile 永不 silent degrade、
安全审查没有未解决 high/critical 时，Phase 4 才完成。

## 12. 一手参考

- [Microsoft AppContainer isolation](https://learn.microsoft.com/windows/win32/secauthz/appcontainer-isolation)
- [Microsoft UpdateProcThreadAttribute](https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
- [Microsoft SetInformationJobObject](https://learn.microsoft.com/windows/win32/api/jobapi2/nf-jobapi2-setinformationjobobject)
- [Microsoft CreateRestrictedToken](https://learn.microsoft.com/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken)
- [OpenAI Codex Windows sandbox crate](https://github.com/openai/codex/tree/902bd9e06b3ecb32cbf7f8e64cd23b956be3e7fe/codex-rs/windows-sandbox-rs)
- [Gemini CLI Windows sandbox](https://github.com/google-gemini/gemini-cli/tree/1ac3377395868295e128b96726d605a900b5946b/packages/core/src/sandbox/windows)
- [Chromium sandbox design](https://github.com/chromium/chromium/blob/024a2d21125b57ffbb41f6e635294966b0d5eba4/docs/design/sandbox.md)
- [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)
- [OpenCode Windows/WSL guidance](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/web/src/content/docs/windows-wsl.mdx)
