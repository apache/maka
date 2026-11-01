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
