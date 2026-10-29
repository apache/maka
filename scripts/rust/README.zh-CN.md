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

# Native build tooling

[English](README.md)

这些脚本从指定源码构建原生包及 npm 启动器。对外构建与发布顺序见 [packages/cli](../../packages/cli/README.zh-CN.md)。

macOS 原生打包需要 Xcode 26 或更新版本。Linux 需要 GLib、X11/XCB、xkbcommon、Wayland、Fontconfig 和 FreeType 开发文件，以及 cargo-zigbuild 与 Zig。[原生 CI 工作流](../../.github/workflows/npm-publication.yml)记录构建环境。

Rust 构建需要 libclang 来生成 SQLite preupdate-hook 绑定，即使已有 V8 缓存包也需要。

发布包使用关闭可选 LGPL glibc 数学代码的固定 V8 构建。完成的库、绑定和 notices 缓存在 `target/v8` 或 `$CARGO_TARGET_DIR/v8`。缓存未命中时，构建器下载 [v8-prebuilts.json](v8-prebuilts.json)指定的包并校验摘要。缓存损坏或固定来源失效会直接报错；没有对应固定来源时才从源码构建。源码构建还需要 Python、Git、Clang/libclang 19 或更新版本、C++ 工具链，以及较多磁盘空间和时间。

缓存键标识 V8 源码、目标、特性和生成代码。新增键时，使用已完成原生工作流输出的精确归档，将其发布为带版本的依赖预发布资产，再把 URL、哈希和验证依据写入 manifest。保留已有资产及键的含义。每个包仍执行原生链接和 smoke 检查。

依赖变更后执行：

```sh
node scripts/rust/dependencies.mjs generate
node scripts/rust/notices.mjs generate
node scripts/rust/dependencies.mjs check
node scripts/rust/notices.mjs check
```

检查生成的清单和许可证文本。[notices-sources.json](notices-sources.json)记录已审查的上游例外。发布组装还包含实际 V8 构建与 Rust 标准库的 notices。TSV 清单不能替代完整许可证文本。

终端行为使用当前 [terminal-shell 真实 Host 测试](../../products/maka/terminal-shell/tests/real_host.rs)，包含生产 PTY 生命周期。通过 `cargo test -p maka-cli --no-default-features --test terminal_real_host` 运行。比较保留的 release 产物时，使用相同渲染器、终端协议、视口和负载；分别报告输入延迟、帧编码和输出传输。

长任务对比使用两个版本保留的 release 测试可执行文件，基准夹具必须相同。
通过 `cargo test --release --no-run` 构建 `maka-event-log --test archive`
和 `maka-agent-engine --test integration`，然后运行：

```sh
python3 scripts/rust/benchmark-long-task.py --kind engine \
  --baseline /tmp/engine-before --candidate /tmp/engine-after \
  --sizes 250,1000 --runs 5 --output /tmp/maka-long-task
```

归档测试可执行文件使用 `--kind prune`；真实上下文压缩后的 Engine 测量使用
`--checkpoint`。脚本交替运行两个版本，检查实际完成的工作相同，保留原始日志、
错误、中位数和范围。记录构建 profile、目标架构和依赖 feature；feature unification
可能使独立测试与产品使用不同的哈希后端。使用 `sha2` 0.10 的旧 Engine 基线在受支持的
ARM64 平台上需加 `--features sha2/asm`，才能与产品后端一致。当前依赖在运行时选择
受支持的 CPU 指令，并保留软件回退。

造数据不计时；Engine 耗时涵盖请求送达与执行完成，不包含
Host IPC。[Engine 夹具](../../plugins/agent/engine/tests/integration/long_task_perf.rs)
和 [prune 夹具](../../platform/event-log/tests/archive/performance.rs) 提供工具稀疏、
工具密集及投影大小等参数。测量时不要同时构建；CPU 剖析与耗时对比分开运行。

测量 1,000 / 10,000 / 100,000 轮时，将 `MAKA_ENGINE_PERF_FIXTURE_DIR` 指向
系统临时目录内的一次性目录，并用 `MAKA_ENGINE_PERF_FIXTURE_TAG` 明确标记版本。
Engine 夹具走真实 append 校验，每 1,000 轮执行真实压缩；关闭后的 SQLite 快照
按全部负载参数及夹具源码哈希缓存，修改夹具会使缓存失效。对夹具源码一致的保留
可执行文件运行 `--kind engine --checkpoint --sizes 1000,10000,100000`。
造数据与请求耗时分开，前者可能远长于实际测量过程。

历史与取消测试使用 `--kind responsive`，并将 `MAKA_RESPONSIVENESS_FIXTURES`
设为上述一次性 `.sqlite` 快照路径，以逗号分隔。它验证真实的有界
历史页，以及 admission 前、admission 完成后 10 ms 和模型 HTTP 请求到达后的取消。
`long_history_window` 在打开复制的存储后直接测量首个历史页，不含打开时首次安装目录
的耗时；首次安装必须单独测量。保留的 `long_history_preparation` 记录仍表示旧探针的
先准备再读取过程，不重新解释为直接读取结果。
admission 前覆盖普通与手动消息预检：10 ms 触发时 start 必须仍在等待，随后取消且
不产生 opening 或模型请求。夹具需足够大，提前完成 admission 会使测试失败。
admission 后的定时触发不保证引擎仍处于准备阶段，需核对模型请求计数。
停止计时截至 start 返回取消，或已 admission 的 Engine 完成清理且持久化取消结果；
不包含 EventLog 关闭时等待被放弃读取结束的时间。
这些是存储／Engine API 指标，不是 GUI 或 Host IPC 延迟。上下文与裁剪读取在
调用方取消后通过 SQLite progress handler 中断，并等事务清理完成后复用连接；
双 reader 回收及事务恢复另有行为测试，不代表任意同步 Rust 计算都可立即中断。

`--kind transcript --sizes 128,512` 使用保留的 release
`maka-event-log --test transcript_index` 可执行文件，补测同一 invocation 内的
大量模型步骤。每个样本从新副本生成 transcript，并逐条核对助手消息内容。

`--kind executor --sizes 128,512` 用同一 transcript 可执行文件测量外部执行器
的连续工具调用，并将全部持久化消息与 canonical replay 对比，覆盖工具进度、
结果和最终 invocation 状态。

要测量同一活跃 Host 会话中的多轮压缩，保留 release 构建的
`maka-agent-native --lib` 测试可执行文件，再运行：

```sh
MAKA_COMPACTION_CYCLES=10 MAKA_COMPACTION_PROMPT_BYTES=65536 \
  "$NATIVE" owner::tests::scale::compaction::real_host_same_session_compaction \
  --ignored --exact --nocapture --test-threads=1
```

每轮新增输入并通过真实 Host 回执执行手动压缩。最后一次请求验证最新 checkpoint
已被采用，分页历史核对原始消息。`MAKA_AGENT_COMPACTION` JSON 输出实际请求与
checkpoint 数量、已验证字节数及各操作的延迟／CPU 时间。操作计时排除初始化、
证据读取和关闭，但包含同进程内的受控 HTTP 模型。请求 JSON 大小是规范化后的
序列化长度；峰值 RSS 覆盖整个进程。该探针使用四个 Tokio worker，不测量 IPC、
渲染、自动压缩、模型推理或能耗。

要测量真实 Executor 附件捕获，使用同一个 release native 测试可执行文件：

```sh
MAKA_ARTIFACT_PROBE_BYTES=51847623 \
  "$NATIVE" owner::tests::executor::executor_attachments_use_only_owned_immutable_uploads_and_original_receipts \
  --exact --nocapture --test-threads=1
```

该设置只改变第一个上传文件，另十六个小文件保留顺序、字节／摘要、权限和原操作
重放校验。`MAKA_ARTIFACT_PROBE` 输出实际工作量、SQLite 版本、观察到的完成延迟／CPU
及清理结果。阶段计时排除上传，但包含 Host 准备、同步服务读取／摘要和观察开销；
服务入口的观察时间可能已包含整个服务调用。峰值 RSS 包含驱动程序。比较时保持
测试源码和特性一致，每个大小至少交替运行五次，另行采集 profile；这些指标不是
独立 SQLite、IPC、渲染、模型推理或能耗测量。

要在 Unix 上测量真实服务工具执行，使用同一个 release native 测试可执行文件，每个进程
只运行一个 case：

```sh
MAKA_TOOL_STORM_CALLS=64 MAKA_TOOL_STORM_PAYLOAD_BYTES=128 \
  MAKA_TOOL_STORM_BACKEND=native \
  "$NATIVE" owner::tests::service_tools::storm::real_service_tool_storm \
  --ignored --exact --nocapture --test-threads=1
```

该 case 连续执行 mutation。改用同模块的 `real_service_query_fanout` 可测量
同一模型 step 中的只读调用；backend `javascript` 使用真实 JavaScript 服务。
fanout 数量不代表同时执行的 handler 数量。`MAKA_AGENT_TOOL_STORM` JSON 记录
`calls`、`payload_bytes`、`query`、`backend`、`summary_requests` 和 `wall_ms`。
每次运行都核对精确工具结果、完整公开历史、checkpoint 与摘要请求的一致性，以及清理完成状态。
耗时包含受控 HTTP responder；模型推理和界面渲染不在此探针的测量范围内。

要在 Unix 上验证真实图像上传，使用同一个 release native 测试可执行文件：

```sh
MAKA_IMAGE_COUNT=2 MAKA_IMAGE_SIDE=512 \
  "$NATIVE" owner::tests::scale::image_upload::real_image_upload_vision_scale \
  --ignored --exact --nocapture --test-threads=1
```

通过 `MAKA_IMAGE_PROTOCOL` 选择实际协议：默认 `openai-compatible`，或
`openai-chat-completions`、`anthropic`、`responses`。Compatible 设置
`MAKA_IMAGE_RETRY=true` 时会收到一次明确的 `stream_options` 拒绝；
两次 HTTP 请求都必须包含全部原图。

每个进程生成不同的有效 RGBA PNG，完整解码核验后，逐张捕获文件快照并通过 Host
上传。探针核对持久上传回执、原始 artifact 字节和 canonical 引用、真实 provider
HTTP 请求中有序且精确的图像、完整公开历史和清理结果。只有原图精确送达才通过；
上传已受理或以替代文字完成回答均不算成功。`MAKA_AGENT_IMAGE_SCALE` 记录实际编码
大小、像素尺寸、分阶段计时、进程峰值 RSS 和失败证据。生成和校验与上传、turn
分别计时，但其内存仍计入进程峰值 RSS。HTTP responder 和校验在同一进程运行。
该探针不测量产品像素解码、IPC、渲染、真实模型推理或能耗。分别扩张图像数量与尺寸；
若现有边界阻止原图送达，保留失败 case。

在 Linux 上离线比较生产 Rust 与 TypeScript Host，可使用
[Host 对比工具](host-comparison/README.md)。工具通过真实公开客户端调用本地 SSE
服务，逐字核验持久化结果，并保留进程和系统指标。后台 agent 容量测试分别记录
请求的会话数、实际活跃执行数、已确认完成数及结果未确认的调用。

## Windows State Root 所有权

新 State Root 目录在创建时就明确指定当前账号为所有者，并设置私有 ACL。否则，提权后的 Windows 令牌可能默认将所有者设为 Administrators 组。已有目录在 Root 校验前保持原有权限；程序不会接管非空且无法识别的目录。

旧 TypeScript 版和 Rust 版共用 `%LOCALAPPDATA%\Maka\state-root-owners` 与 `%LOCALAPPDATA%\Maka\runtime-hosts`。如果已有目录属于 Administrators，启动错误会报告路径、实际所有者和期望所有者的 SID。程序不会自动接管所有权。

仅当你确认该目录是自己的 Maka 状态时，先停止本地全部 TypeScript 和 Rust Host。检查错误中的路径和目录内容，再在提权 PowerShell 中备份安全描述符，并只将该目录的所有者改为当前账号：

```powershell
$path = 'C:\Users\YOUR_ACCOUNT\AppData\Local\Maka\state-root-owners'
$acl = Get-Acl -LiteralPath $path
$acl | Format-List Owner,AccessToString
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544') {
    throw 'This recovery step is only for a reviewed Administrators-owned directory.'
}
$backup = [System.IO.Path]::GetTempFileName()
$acl.Sddl | Set-Content -LiteralPath $backup
$acl.SetOwner([System.Security.Principal.WindowsIdentity]::GetCurrent().User)
Set-Acl -LiteralPath $path -AclObject $acl
Write-Output "Previous security descriptor: $backup"
```

重试启动；程序会校验目录，并将访问权限收紧为当前账号和 SYSTEM。后续若报告其他目录，应逐个检查，包括此前启动失败后遗留的空 Root。保留备份直到启动成功。不要删除或替换锁文件、递归接管状态目录，也不要修改无法确认来源的目录所有者。
