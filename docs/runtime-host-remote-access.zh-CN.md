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

# 连接远程 Runtime Host

[English](./runtime-host-remote-access.md)

Maka Desktop、TUI 和 CLI 可以通过 TLS、SSH 或明确启用的明文 WebSocket 连接 Runtime Host。

## 设置 Linux Host

在具备 Node.js 22.19 或更新版本以及可用 systemd user manager 的 Linux 机器上，发布版 CLI 可以用一个命令安装并验证持久 Runtime Host：

```sh
npx --yes --package maka-agent@next maka runtime-host setup \
  --principal my-desktop \
  --preset desktop-client \
  --root /srv/maka \
  --project-root projects=/srv/projects
```

`--principal` 应使用稳定标识；重复执行会替换该 Client 的 credential，不会不断累积 credential。命令会把当前精确版本的 Maka 安装到托管目录，启动仅监听 loopback 的服务，验证新 credential，然后只显示一次连接信息。TUI 或 CLI 使用 `terminal-client`。

在 Host 上运行 `npx --yes --package maka-agent@next maka runtime-host service uninstall` 会删除 service 与托管 package，但保留 State Root 和 Project 数据。

## 手动设置 Host

在远程机器构建 Maka，选择持久的 State Root，并注册允许 remote Client 使用的 Project：

```sh
npm run build
npm --workspace maka-agent exec -- maka runtime-host project add /srv/projects/example --root /srv/maka
npm --workspace maka-agent exec -- maka runtime-host project list --root /srv/maka
```

Desktop 目录选择器默认发布运行服务的用户主目录。如需改为明确的目录 allowlist，可在启动服务时传入一个或多个命名根目录：

```sh
npm --workspace maka-agent exec -- maka runtime-host serve \
  --root /srv/maka \
  --project-root projects=/srv/projects \
  --project-root data=/mnt/data \
  --websocket-port 7443
```

只要提供了 `--project-root <label>=<absolute-path>`，远程目录浏览就只会显示这些根目录。该参数最多可重复八次。Maka 会在启动时解析每个根目录，并确保浏览和注册始终限制在当前选择的根目录内。

Project path 始终留在 Host。为每个 Client 签发 credential：

```sh
npm --workspace maka-agent exec -- maka runtime-host access issue \
  --root /srv/maka \
  --principal my-desktop \
  --preset desktop-client
```

TUI 或 CLI 使用 `terminal-client`。命令只显示 credential 一次。

在使用 systemd user manager 的 Linux 上，持久安装的 CLI 可以让 loopback Host 在 SSH 会话结束后
继续运行：

```sh
maka runtime-host service install \
  --root /srv/maka \
  --project-root projects=/srv/projects
maka runtime-host service status --json
```

安装命令会持久保存当前精确的 Node 与 Maka CLI 路径。重复执行会更新同一个 service；未指定
WebSocket port 时会保留现有端口。卸载 npm 包前，应先执行
`maka runtime-host service uninstall`。卸载 service 会保留 State Root 与 Project 数据。如果
systemd user lingering 未启用，安装会给出可操作的错误，不会声称服务能够持久运行。Service
必须从持久的全局 Maka 安装中安装，不能使用 `npx`。替换操作只会在新的 Runtime Host ready
之后提交；失败时会恢复之前的 service。

## 选择连接方式

### Direct TLS

具有稳定网络入口的 Host 使用 TLS：

```sh
npm --workspace maka-agent exec -- maka runtime-host serve \
  --root /srv/maka \
  --websocket-host 0.0.0.0 \
  --websocket-port 7443 \
  --tls-certificate /etc/maka/tls.crt \
  --tls-private-key /etc/maka/tls.key \
  --json
```

### SSH tunnel

当远程机器已经能通过 OpenSSH 访问时，可以让 Runtime Host 只监听 loopback：

```sh
npm --workspace maka-agent exec -- maka runtime-host serve \
  --root /srv/maka \
  --websocket-port 7443 \
  --json
```

Maka 不经过 shell，直接运行系统 `ssh`，把 Client 的临时 loopback port 转发到 Host 的 loopback listener。正常的 OpenSSH alias、key、agent 与 host verification 仍然生效；配置了额外 port forwarding 的 Host 条目会被拒绝。Maka 不会修改 SSH config，也不会在删除 Profile 时清理共享的 OpenSSH 状态。

用户主动首次连接时，Desktop 会打开内嵌终端，让 OpenSSH 完成 host-key 确认、密码或 key passphrase 输入；TUI 会在当前终端显示相同提示。后台重连和非交互 CLI 使用 OpenSSH batch mode，因此需要预先配置 SSH key 或 agent。

### 明确启用明文连接

明文连接不会加密 access credential 或 Session traffic。它只适合可信且隔离的网络，并要求 Host 与 Client 分别明确同意：

```sh
npm --workspace maka-agent exec -- maka runtime-host serve \
  --root /srv/maka \
  --websocket-host 0.0.0.0 \
  --websocket-port 7443 \
  --allow-insecure-remote \
  --json
```

Client Profile 还必须单独持久化明文风险确认。Maka 不会把 TLS 或 SSH 自动降级为明文。复制 service 命令输出的 JSON `rootId`；Client 会用它固定预期的 State Root。

## 连接 Desktop

打开`设置 → 工作区 → Runtime Host`，选择**添加电脑**并填写 OpenSSH 目标。Desktop 会在交互式 SSH 会话中运行已发布的 setup 命令，保存返回的 credential，验证 tunnel，然后打开远程 Project 选择器。

已有 TLS、SSH 或明确允许的明文 endpoint 可通过**手动配置**添加。

Credential 与 Profile 分开存储。Desktop 会让 Local 与每个已启用的 remote Host 独立保持连接，并允许指定一个默认 Host 来创建新 Session；已有 Session 仍使用自己的 Host。Remote connection 失败时仍会显示，但不会中断其他 Host。连接后从该 Host 已注册的 Project 中选择一个；Client 本地目录操作不可用。

对于通过 SSH 管理的电脑，可从其**管理**操作查看已安装版本、服务状态、可用目录和近期日志，也可以启动、重启、修复或卸载服务。卸载会保留远端 State Root，且不会删除 Desktop Profile；移除 Profile 也不会卸载远端服务。手动配置的 direct connection 仍可正常使用，但需要在 Host 机器上管理服务。

## 连接 TUI 或 CLI

把 target 保存为共享 Profile。只在创建或更新 Profile 时通过环境变量提供 credential：

```sh
export MAKA_RUNTIME_HOST_ACCESS_CREDENTIAL='<credential>'

# Direct TLS
maka runtime-host profile set \
  --id office --name Office \
  --tls-url wss://runtime.example.com:7443/runtime-host \
  --expected-root '<rootId>'

# 或 SSH
maka runtime-host profile set \
  --id office-ssh --name 'Office SSH' \
  --ssh-destination user@runtime.example.com \
  --ssh-remote-port 7443 \
  --expected-root '<rootId>'

# 或明确启用明文连接
maka runtime-host profile set \
  --id lab --name Lab \
  --plaintext-url ws://192.0.2.10:7443/runtime-host \
  --acknowledge-plaintext \
  --expected-root '<rootId>'

unset MAKA_RUNTIME_HOST_ACCESS_CREDENTIAL
```

然后明确选择 Host 上的 Project：

```sh
maka --host office --project '<projectId>'
maka run --host office --project '<projectId>' "总结这个项目"
```

每个 TUI 或 CLI 进程只连接一个 Profile。TUI 的首次 SSH 连接可以交互；非交互命令要求提前配置认证。

## 兼容性排查

`RUNTIME_HOST_REMOTE_INCOMPATIBLE` 表示 Client 与远程 Runtime Host 无法安全通信。先比较 Client 与 Host 的 compatibility epoch；当诊断中提供相关信息时，也应检查 Client 和 Host 的 protocol range、composition ID，以及 Host 的 composition revision。

请使用彼此兼容的 Client 和 Host build。更新 Host 后，由 Host 的 operator 重启远程 Runtime Host service，然后重试连接。

Remote Client 不会自动升级或重启 Host、降级 transport、修改 Profile、默认 Host 或 Session，也不会在此诊断中暴露 credential、endpoint、path 或 State Root。

## 安全边界

- 不要把 credential 放在命令行或 Profile JSON 中。
- 明文连接需要持久的 Client 确认和独立的 Host 启动参数。
- Session response 中的 `hostCwd` 只是 Host metadata，不能通过 Client filesystem 解释。
- Runtime Host protocol operation 不能升级、重启或终止 service process；Desktop 管理使用独立认证的
  SSH operator channel。若 durable commit 的结果无法确定，Host 仍会主动 drain；managed service
  supervisor 会将其重新拉起。
- 在 Host 上使用 `maka runtime-host access revoke --root /srv/maka --credential <credentialId>` 撤销 credential。
