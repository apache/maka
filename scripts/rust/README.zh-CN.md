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

# 原生构建与 CI 工具链

[English](README.md)

`scripts/rust/` 与 `scripts/ci/` 负责跨平台原生打包、V8 预编译缓存、第三方许可证审计以及 CI 测试套件编排。完整发包命令顺序见 [`packages/cli`](../../packages/cli/README.zh-CN.md)。

## 编译环境与 V8 预编译包

- **macOS** — 需要 Xcode 26+ 以及 `libclang`（用于生成 SQLite preupdate-hook 绑定）。
- **Linux** — 需要 GLib、X11/XCB、`xkbcommon`、Wayland、Fontconfig、FreeType 开发头文件、`libclang`、`cargo-zigbuild` 与 Zig（具体环境对齐 [`.github/workflows/npm-publication.yml`](../../.github/workflows/npm-publication.yml)）。
- **V8 缓存** — Release 构建按 [`v8-prebuilts.json`](v8-prebuilts.json) 下载关闭了 LGPL glibc 数学库的预编译 V8 静态库并缓存至 `target/v8`（或 `$CARGO_TARGET_DIR/v8`），校验 SHA-256 摘要后复用；若未命中锁定配置则会回退到耗时的 V8 源码编译（需 Python、Git 与 Clang/libclang 19+）。

## 依赖与许可证清单

增删改 Cargo 依赖或前端打包依赖后，重新生成并校验许可证与 Notice 清单：

```sh
node scripts/rust/dependencies.mjs generate
node scripts/rust/notices.mjs generate
node scripts/rust/dependencies.mjs check
node scripts/rust/notices.mjs check
```

`notices.json` 记录各目标平台已审阅的 Rust 及内嵌 JS 组件摘要，[`notices-sources.json`](notices-sources.json) 维护上游许可证文本映射。

## CI

测试套件统一在 [`scripts/ci/suites.mjs`](../ci/suites.mjs) 定义，本地 `just` 与 [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) 共用 [`scripts/ci.mjs`](../ci.mjs) 执行：

```sh
node scripts/ci.mjs plan --base origin/rust-preview
node scripts/ci.mjs run bridge
```

PR 计划根据 Cargo 反向依赖图以及声明的运行时资源（如内置 `skills/`、产品包与辅助子进程二进制）精准计算受影响套件；改动公共配置则触发全量矩阵。主构建任务产出一份包含运行时资源的 `cargo nextest` 归档，由各平台测试节点分片消费。

## 性能基准测试

[`host-comparison/`](host-comparison/README.md) 提供离线 Linux 端到端压测工具，基于本地回环 SSE 模拟器对比不同构建的吞吐量、RSS 内存与 CPU 开销。

## Windows State Root 目录属主恢复

Maka 在 `%LOCALAPPDATA%\Maka` 下新建目录时会显式绑定当前登录用户与私有 ACL。若早期提权运行导致 `state-root-owners` 或 `runtime-hosts` 属主落为 `Administrators`（`S-1-5-32-544`），启动时会拒绝自动接管并打印实际与预期 SID。确认目录属于本人后，先停止本机所有 Host 进程，再在管理员 PowerShell 中执行：

```powershell
$path = 'C:\Users\YOUR_ACCOUNT\AppData\Local\Maka\state-root-owners'
$acl = Get-Acl -LiteralPath $path
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544') {
    throw 'Expected an Administrators-owned directory.'
}
$backup = [System.IO.Path]::GetTempFileName()
$acl.Sddl | Set-Content -LiteralPath $backup
$acl.SetOwner([System.Security.Principal.WindowsIdentity]::GetCurrent().User)
Set-Acl -LiteralPath $path -AclObject $acl
Write-Output "Backed up previous SDDL to: $backup"
```
