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

# maka-sandbox

[English](README.md)

`maka-sandbox` 将 Host 的文件系统与网络策略编译为操作系统级命令隔离。调用准入与回执记录归 Host 管理，子进程 I/O 与生命周期归 [`maka-process`](../process/src/lib.rs) 管理。

## 各平台后端

- **macOS** — 基于 Seatbelt（`sandbox-exec`）。`allowed` 网络策略放行系统 `mDNSResponder` 套接字但仍屏蔽其余 Host Unix 套接字；`restricted` 策略统一走当前执行独占的本地代理完成解析与转发。
- **Linux** — 基于 `bubblewrap`（需 `/usr/bin/bwrap` 0.11+）与非特权网络命名空间。
- **Windows** — 优先使用 [Microsoft MXC](https://github.com/microsoft/mxc) 为每个命令树创建原生安全环境，无需 UAC 提权、无需专用本地账户、不改写既有文件 ACL，也无需提前执行 `maka sandbox setup`。可写目录内的只读例外子路径通过可恢复占位守卫实现。仅当策略超出 MXC 表达能力时，才切回需显式执行 `maka sandbox setup --root <path>` 的低权限账户 + WFP + Job 后端；MXC 启动或清理失败会直接报错，绝不静默降级或裸跑命令。

所有平台都会在启动前拒绝无法表达的策略规则。受限网络流量统一经过 Host 托管的代理校验目标 `(host, port)`，HTTP 重定向同样受目标白名单约束。

## 命令行与测试

指定策略 JSON 直接测试隔离效果：

```sh
maka sandbox run --policy policy.json --cwd /absolute/workspace --command 'your command'
```

只读且断网的策略示例：

```json
{"kind":"managed","filesystem":{"default":"read","rules":[],"denyGlobs":[]},"network":"denied"}
```

编译并运行不依赖 V8 的原生 Windows MXC 验收程序：

```powershell
cargo build -p maka-host-runtime --example windows_mxc --target x86_64-pc-windows-msvc
```

在本地磁盘以普通用户运行生成的 `windows_mxc.exe`，可完整验证文件边界、管道与 ConPTY、子进程树回收及网络隔离。

## 源码来源

Seatbelt 策略文件的上游版本、版权与许可证说明见[英文版 Source provenance](README.md#source-provenance)。

`src/windows/mxc.rs` 与 `src/windows/mxc/{availability,policy}.rs` 中的能力探测、网络映射、文件别名规范化、卷展开与启动处理改编自 Codex 的 [MXC 沙箱适配器](https://github.com/openai/codex/tree/4610b573e59b211bf9430cf6ffb97cfb84623090/codex-rs/mxc-sandbox)（commit `4610b573e59b211bf9430cf6ffb97cfb84623090`）。Copyright 2025 OpenAI；Apache-2.0。Maka 在此基础上映射自身文件策略、前置拦截不支持的规则，并持有原生隔离句柄直至进程树彻底结清。Microsoft MXC SDK 为独立锁定的 MIT 许可依赖。
