# 连接远程 Runtime Host

[English](./runtime-host-remote-access.md)

Maka Desktop、TUI 和 CLI 可以通过 authenticated TLS 直接连接远程 Runtime Host。Host 继续独占自己的 Project、模型连接、Session 和执行状态。

当前只支持 Direct TLS。SSH tunnel 和显式不安全的明文连接尚未成为产品能力。

## 准备 Host

在远程机器构建 Maka，选择持久的 State Root，并使用 TLS 证书和私钥启动 service：

```sh
npm run build
npm --workspace maka-agent exec -- maka runtime-host serve \
  --root /srv/maka \
  --websocket-host 0.0.0.0 \
  --websocket-port 7443 \
  --tls-certificate /etc/maka/tls.crt \
  --tls-private-key /etc/maka/tls.key \
  --json
```

Service 会输出一条 JSON ready event，请复制其中的 `rootId`。通配 listener address 只是 bind fact；Client 应使用自己真正能够访问的域名或地址。

保持 service 运行，并在 Host 的另一个终端注册允许远程 Client 使用的目录：

```sh
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

仅供 TUI 或 CLI 使用的 principal 可选择 `terminal-client`。命令只显示 credential 一次。Preset 在签发时展开为明确的 operation grants，不授予 access administration 或 Host-path authority；Maka 日后修改 preset 也不会扩大已有 credential 的权限。

## 连接 Desktop

打开`设置 → 工作区 → Runtime Host`，选择**添加远程 Host**，然后填写：

- 仅在本机使用的显示名称；
- Client 能访问的 `wss://` endpoint；
- ready event 中的 `rootId`；
- 刚刚签发的 access credential。

选择**保存并连接**。Credential 与 Profile 分开存储。Maka 会验证 TLS 证书和确切的 State Root，绝不 fallback 到 Local discovery。连接失败且原 Host 能恢复时，原 Host 会继续工作；配置表单会保留以便修正，已保存的 remote Profile 也可以重试。

连接成功后，从 Host 已注册的 Project 中选择一个。Remote Host 下不会提供本地目录选择器或其他 Client-path 操作。

## 连接 TUI 或 CLI

把同一 target 保存为共享 Profile。只在创建或更新 Profile 时通过环境变量提供 credential：

```sh
export MAKA_RUNTIME_HOST_ACCESS_CREDENTIAL='<credential>'
npm --workspace maka-agent exec -- maka runtime-host profile set \
  --id office \
  --name Office \
  --tls-url wss://runtime.example.com:7443/runtime-host \
  --expected-root '<rootId>'
unset MAKA_RUNTIME_HOST_ACCESS_CREDENTIAL
```

然后明确选择 Host 上的 Project：

```sh
npm --workspace maka-agent exec -- maka --host office --project '<projectId>'
npm --workspace maka-agent exec -- maka run --host office --project '<projectId>' "总结这个项目"
```

每个 TUI 或 CLI 进程只连接一个 Profile。Endpoint 不可达、证书错误、认证失败、Host 不兼容、State Root 不符或 Project 不可用都会作为终端错误报告。

## 安全边界

- 不要把 credential 放在命令行或 Profile JSON 中。
- Direct remote connection 必须使用 `wss:` 和平台证书校验；不存在验证绕过或明文 fallback。
- Service process 由 deployment operator 管理，remote Client 不会升级或终止它。
- 在 Host 上使用 `maka runtime-host access revoke --root /srv/maka --credential <credentialId>` 撤销 credential。
