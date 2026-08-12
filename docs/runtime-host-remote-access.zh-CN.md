# 连接远程 Runtime Host

[English](./runtime-host-remote-access.md)

Maka Desktop、TUI 和 CLI 可以通过 Direct TLS、SSH tunnel 或明确确认风险的明文 WebSocket 连接 Runtime Host。Host 继续独占自己的 Project、模型连接、Session 和执行状态。

## 准备 Host

在远程机器构建 Maka，选择持久的 State Root，并注册允许 remote Client 使用的目录：

```sh
npm run build
npm --workspace maka-agent exec -- maka runtime-host project add /srv/projects/example --root /srv/maka
npm --workspace maka-agent exec -- maka runtime-host project list --root /srv/maka
```

Project path 始终留在 Host。Remote Client 只选择返回的 Project identity，不会把 Client 本地目录重新解释为 Host path。

为每个 Client principal 单独签发 credential：

```sh
npm --workspace maka-agent exec -- maka runtime-host access issue \
  --root /srv/maka \
  --principal my-desktop \
  --preset desktop-client
```

仅供 TUI 或 CLI 使用的 principal 可选择 `terminal-client`。命令只显示 credential 一次。Credential 不授予 access administration 或任意 Host-path 权限。

## 选择连接方式

### Direct TLS

具有稳定网络入口的 Host 应使用 TLS：

```sh
npm --workspace maka-agent exec -- maka runtime-host serve \
  --root /srv/maka \
  --websocket-host 0.0.0.0 \
  --websocket-port 7443 \
  --tls-certificate /etc/maka/tls.crt \
  --tls-private-key /etc/maka/tls.key \
  --json
```

Client 使用可达的 `wss://` URL，并执行正常的平台证书校验。

### SSH tunnel

当远程机器已经能通过 OpenSSH 访问时，可以让 Runtime Host 只监听 loopback：

```sh
npm --workspace maka-agent exec -- maka runtime-host serve \
  --root /srv/maka \
  --websocket-port 7443 \
  --json
```

Profile 保存 SSH destination、可选 SSH port、远程 WebSocket port 与 path。Maka 不经过 shell，直接运行系统 `ssh`，把 Client 的临时 loopback port 转发到 Host 的 `127.0.0.1:7443`。

Maka 会读取正常的 OpenSSH 配置，但会拒绝自行添加了 local、remote 或 dynamic forwarding 的 Host 条目，确保连接只拥有一条 loopback tunnel。Maka 不会修改 SSH config、key、agent 或 `known_hosts`。用户确认 host key 后，OpenSSH 可能自行写入 `known_hosts`。删除 Maka Profile 只会删除该 Profile 和对应的 Runtime Host credential；共享的 OpenSSH 状态仍由用户管理。

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

Client Profile 还必须单独持久化明文风险确认。Maka 不会把 TLS 或 SSH 自动降级为明文。

每种 service 命令都会输出一条 JSON ready event。复制其中的 `rootId`，Client 会用它确认连接的是预期 State Root。

## 连接 Desktop

打开`设置 → 工作区 → Runtime Host`，选择**添加远程 Host**，选定连接方式，再填写对应 endpoint、ready event 中的 `rootId` 和刚签发的 credential，然后选择**保存并连接**。

Credential 与 Profile 分开存储。连接失败时，当前 Host 会继续工作，未完成的 Profile 会被删除；连接成功后 Profile 才会保留。随后从 Host 已注册的 Project 中选择一个。Remote Host 下不会提供本地目录选择器或其他 Client-path 操作。

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

每个 TUI 或 CLI 进程只连接一个 Profile。TUI 的首次 SSH 连接可以交互；非交互命令会报告 SSH 失败，并要求提前配置认证。

## 安全边界

- 不要把 credential 放在命令行或 Profile JSON 中。
- 优先使用 TLS 或 SSH。明文连接需要持久的 Client 确认和独立的 Host 启动参数。
- SSH 只在两端 loopback 之间转发；Host verification 与 authentication 仍由系统 OpenSSH 负责。
- Session response 中的 `hostCwd` 只是 Host metadata，不能通过 Client filesystem 解释。
- Remote Client 不会升级或终止 service process。
- 在 Host 上使用 `maka runtime-host access revoke --root /srv/maka --credential <credentialId>` 撤销 credential。
