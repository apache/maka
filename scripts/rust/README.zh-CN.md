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

## OAR worker

正常 CLI 构建会从同一源码目录执行 `scripts/oar/build.mjs`，使用根 lockfile 固定的 OAR 与 Deno 版本：先打包 ESM，再编译独立 Deno 可执行文件，将 `maka-oar-worker[.exe]` 放在 `maka[.exe]` 同级。原生包及缓存校验都要求该 worker。运行时不需要 Node/npm 或模块下载；构建不会更新 OAR，也不会安装 agent。

开发模式使用官方 Deno 模板。`buildCli({ release: true })` 及 `node scripts/oar/build.mjs --release --target TRIPLE --output DIRECTORY` 则使用 `scripts/oar/runtime-source.json` 固定源码和受控 V8 归档、bindings（`v8_use_libm_trig_functions=false`）构建 denort。复用既有 `buildV8` 政策：有固定 prebuilt 就使用，否则由既有 `compileV8` 构建受控源码及 notices，不缩减原有五个发行目标。独立 Cargo target 目录中的 CLI snapshot 也由该 V8 构建。固定 Deno CLI 通过 `DENORT_BIN` 使用模板；缺少受控 denort 模板、构建失败、版本/目标不匹配或模板字节改变均硬失败，不回退官方模板。模板选择依据输出 target，而非 host。`worker-receipt.json` 记录源码 revision、V8 输入、denort、bundle、worker 的哈希链；worker 每次调用都会重编。

实际官方 Deno 2.9.6 Linux x64 worker 中发现了已定义的 `glibc_sin`、`glibc_cos`、`__branred`，来自 V8 的 LGPL 数学实现，不能只补 Deno npm 包的 MIT 文本就认定可以发行。此前官方 Linux x64/arm64 样本最高需要 GLIBC_2.27；这既不是受控运行时的验证，也不是 glibc 2.28 系统上的运行证明。受控 GNU Linux denort 同样使用 `cargo zigbuild --target TRIPLE.2.28`。Linux 发行组装仍使用 `readelf --version-info` 检查**实际** worker，拒绝高于 glibc 2.28 的依赖；构建参数本身不是 ABI 验证。本轮仅构建 aarch64 macOS，其余四个目标未构建。

许可检查读取 worker 实际 esbuild `bundle-inputs.json`。release 还从**本次构建**的非 dev Cargo metadata 闭包、固定 Deno source archive、该目标 V8 notices 和精确 Rust 工具链生成 `runtime-notices.txt`，由 `buildCli` 作为 `oarRuntimeNotices` 传给 `verifyNotices`。`notices-sources.json` 每个 `deno-runtime@2.9.6/TRIPLE` 条目必须指向一个已审阅的本地完整正文。缺目标、版本/目标头不匹配、实际正文与已审正文任何差异，均在查询 Cargo metadata 前硬失败；既有 `notices.json` 快照继续核对审阅内容。默认生成要求五个目标条目齐全，不能以 macOS 正文覆盖 Linux/Windows。

受控构建完成后，`node scripts/oar/runtime-notices.mjs --target TRIPLE` 可从现有 receipt 重新生成审阅资料，不重建运行时，也不下载其它平台 metadata。输出位于 `$XDG_CACHE_HOME/maka/oar-runtime/TRIPLE`（默认 `~/.cache/maka/oar-runtime/TRIPLE`）：`license-inputs.json`、`license-records.json`、`THIRD_PARTY_NOTICES.txt`。aarch64 macOS 正文包含 760 个包（704 个外部包）；因包含构建依赖而偏保守，不是精确链接清单，更不是跨平台闭包。

不再仅依赖不可达 SWC revision：已核对 checksum 锁定的发布 crate、逐版本声明，并保留 Rust/core-js、Deno/Node、libdivsufsort 等原版权。依据 package declaration 补入的标准条款明确标注来源，不冒充恢复的 upstream NOTICE。发布包可能缺少其引用的文件；保留已有原始头和声明，不编造缺失文件。aarch64 macOS 的完整正文已保存到 [deno-runtime-2.9.6-aarch64-apple-darwin.txt](licenses/deno-runtime-2.9.6-aarch64-apple-darwin.txt)，仅登记 `deno-runtime@2.9.6/aarch64-apple-darwin`。其它四个目标本轮既未构建，也未完成审阅，仍然阻断。开发构建不承担受控 denort 编译及该发行许可门禁。

单目标审核完成后，同时提供该 target 和实际 runtime 正文，更新及验证仅覆盖该目标的发行快照。省略这些参数时仍要求五个目标记录齐全：

```sh
node scripts/rust/notices.mjs generate --target aarch64-apple-darwin \
  --oar-runtime-notices "$HOME/.cache/maka/oar-runtime/aarch64-apple-darwin/THIRD_PARTY_NOTICES.txt"
node scripts/rust/notices.mjs check --target aarch64-apple-darwin \
  --oar-runtime-notices "$HOME/.cache/maka/oar-runtime/aarch64-apple-darwin/THIRD_PARTY_NOTICES.txt"
```

PR CI 使用 `node scripts/rust/notices.mjs check-reviewed`，从 supplement 条目和现有快照共同推导目标集合，核对这些目标当前产品依赖及许可摘要。删除审核条目不能静默缩小覆盖，新增目标也必须进入快照。这只检查已审源码输入，不代表批准任何新构建的 runtime。发行 `check --target ...` 仍必须逐字比较实际构建正文；默认生成仍要求五个发行目标齐全。

依赖变更后执行：

```sh
node scripts/rust/dependencies.mjs generate
node scripts/rust/notices.mjs generate
node scripts/rust/dependencies.mjs check
node scripts/rust/notices.mjs check
```

检查生成的清单和许可证文本。[notices-sources.json](notices-sources.json)记录已审查的上游例外。发布组装还包含实际 V8 构建与 Rust 标准库的 notices。TSV 清单不能替代完整许可证文本。

`notices.json` 记录已审核的组件身份、来源和许可证资料摘要。`notices check` 解析 Rust 依赖闭包，并构建临时产品 bundle 来识别内嵌 JavaScript 包；不会下载许可证文本。仅修改第一方业务源码不会使覆盖检查失效，但从已有 lockfile 中新引入未审核的包会被拒绝。原生打包在构建后、打包前核对当前目标的组件及 Cargo 实际生成的 bundle 输入，复用本次构建而不再次打包 JavaScript。审核清单可以覆盖额外平台。

终端行为使用 [terminal-shell 测试](../../products/maka/terminal-shell/tests/real_host/mod.rs)。通过 `cargo nextest run -p maka-cli --test integration -E 'test(terminal::)'` 运行当前组件和产品交互检查。渲染性能另用固定终端协议、视口和负载的 release 产物比较。

长历史性能使用保留的 [Engine 夹具](../../plugins/agent/engine/tests/integration/long_task_perf.rs)。构建 release 测试程序，比较相同夹具源码和依赖 feature：

```sh
cargo test --release -p maka-agent-engine --test integration --no-run
python3 scripts/rust/benchmark-long-task.py \
  --baseline /tmp/engine-before --candidate /tmp/engine-after \
  --sizes 250,1000 --runs 5 --output /tmp/maka-long-task
```

`--checkpoint` 测量实际上下文压缩后的请求。脚本交替运行两个版本，核对实际工作一致，保留原始样本、中位数和范围。造数据不计入请求和完成耗时；这些指标覆盖 Engine API 与受控 HTTP provider，不是 Host IPC、渲染、模型推理或能耗。

更大历史使用一次性目录 `MAKA_ENGINE_PERF_FIXTURE_DIR` 和明确版本标签 `MAKA_ENGINE_PERF_FIXTURE_TAG`。关闭的快照按负载设置与夹具源码索引，对比保留产物时保持两者一致。造数据与请求耗时分开，前者可能长得多。测量时停止竞争编译，CPU 剖析另行采集。

## CI

[套件目录](../ci/suites.mjs)定义已维护的构建和测试范围，`just` 与 [workflow](../../.github/workflows/ci.yml)使用同一[执行入口](../ci.mjs)。执行 `just setup` 后，可以查看已提交改动的计划或复现套件：

```sh
node scripts/ci.mjs plan --base origin/rust-preview
node scripts/ci.mjs run bridge
```

PR 根据 Cargo 反向依赖和声明的运行时输入选择范围；共享或无法归属的变更执行完整已维护套件。分支 push 和手动运行也执行全量。包级测试筛选保留各套件原有的 workspace/features 编译配方。GPUI 套件覆盖选定的无窗口 platform 和 terminal 测试，不包含独立 host 的 webview/video 配置。

根 producer 生成包含运行时产品资源的 nextest 归档；测试 worker 执行同一产物的分片。最终 `test` 检查要求所有选中工作成功。Cargo 缓存用于加速构建，不代替测试产物。

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
