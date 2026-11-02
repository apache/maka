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

为已授权命令准备操作系统隔离。Host 决定权限并管理执行记录，本 crate 应用文件系统与网络限制。进程 I/O 和生命周期由 [maka-process](../process/README.zh-CN.md)负责。

macOS 使用 Seatbelt，Linux 使用 bubblewrap 和网络命名空间。Linux 需要 `/usr/bin/bwrap` 提供 bubblewrap 0.11 或更新版本。不支持的策略在执行前失败。

Windows 优先使用 [Microsoft MXC](https://github.com/microsoft/mxc)，为每个命令树创建原生进程安全环境。Maka 实际探测创建和启动能力，再检查文件系统策略的具体要求。支持的命令不需要 UAC 提权、专用账户、修改已有对象的 ACL 或执行 `sandbox setup`。根进程退出后，执行所有者继续持有隔离，直到后台后代进程完成清理。只读、工作区可写及关闭沙箱三种选择保持现有含义。

对于可写目录树中的只读例外，Host 复用可恢复的文件保护机制：为缺失路径创建临时占位对象，并固定权限边界及其祖先，防止重命名。每个 Windows 账户使用唯一的受保护注册目录，保存暂存对象和恢复记录。发布占位对象需要同卷原子移动，且不能替换已有对象；不具备该能力时，在执行前拒绝策略。命令树完成清理后，仅回收这些保护机制自己创建且仍为空的对象。

只有能力或策略不支持时，才选择现有低权限账户后端；该后端需要显式执行 `maka sandbox setup --root PATH`，并使用 WFP 规则和 Job。MXC 启动或清理失败会直接报错，不会换后端重试命令，也不会无隔离执行。Host 保持非提权运行。

限制目标的网络流量经过执行所有者持有的网关。路由和凭据留在 Host，重定向目标需要独立权限。Linux 与 Windows 在启动前展开拒绝 glob；之后新增的匹配路径由下次启动覆盖，不属于已有快照。

macOS 的 `allowed` 包含系统解析器使用的 `mDNSResponder` Unix socket，其他 Host Unix socket 仍被禁止。限制目标的进程使用网关解析域名，不会获得该 socket 的直接访问权限。

文件系统权限按路径应用。MXC 会收紧策略中明确列出的对象别名冲突，不会扫描可写目录树中预先存在、未列入策略的硬链接。

MXC 网络语义与 Codex 对齐：`denied` 禁止网络访问，包括 IPv4/IPv6 回环；`restricted` 允许 Windows 的宿主回环访问，包括 `127.0.0.0/8`、`::1` 及宿主的其他本地接口地址。远程目标必须经过执行所有者持有的代理，由代理检查已授权的目标主机与端口。因此，受限策略允许访问代理以外的本地服务。`allowed` 允许正常联网。

通过实际后端测试策略：

```sh
maka sandbox run --policy policy.json --cwd /absolute/workspace --command 'your command'
```

Windows 的 `--root` 选择 Host 状态目录；MXC 支持的策略不要求在其中配置专用账户。只读且无网络的策略示例：

```json
{"kind":"managed","filesystem":{"default":"read","rules":[],"denyGlobs":[]},"network":"denied"}
```

设置、状态查询和移除命令见 `maka sandbox --help`。这些机制约束模型驱动的副作用；可信原生插件代码运行在 Host 进程内。

原生 Windows 验证程序使用真实 Host 后端和进程传输，不依赖 CLI 的 V8：

```powershell
cargo build -p maka-host-runtime --example windows_mxc --target x86_64-pc-windows-msvc
```

将生成的 `windows_mxc.exe` 放在 Windows 本地路径，以普通用户身份运行。它在 `LOCALAPPDATA` 创建并清理自己的临时目录，验证文件系统限制、参数与环境、管道及 ConPTY I/O、后代进程生命周期、取消和网络。网络检查要求无沙箱的宿主能够通过 TCP 连接 `example.com:443`，作为正向对照，并在 `allowed` 沙箱内部验证域名解析与域名连接，不发送 HTTP 请求。MXC 不可用会使验证失败，不会跳过检查。

Seatbelt 策略的上游版本、版权和许可证记录见[英文版来源说明](README.md#source-provenance)。

`src/windows/mxc.rs` 与 `src/windows/mxc/{availability,policy}.rs` 中的原生能力探测、网络映射、文件别名规范化、卷展开和启动处理改编自 Codex 的 [MXC 沙箱适配器](https://github.com/openai/codex/tree/4610b573e59b211bf9430cf6ffb97cfb84623090/codex-rs/mxc-sandbox)，版本为 `4610b573e59b211bf9430cf6ffb97cfb84623090`。Copyright 2025 OpenAI；Apache-2.0。Maka 映射自身的文件权限策略，在执行前拒绝不可表达的规则，保留命令环境契约，并持有原生隔离资源直至进程结算。Microsoft MXC SDK 是单独固定版本的 MIT 许可依赖。
