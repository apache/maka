---
doc_id: architecture.mcp-runtime-architecture-draft
title: "Maka MCP runtime architecture"
language: zh-CN
source_language: zh-CN
implementation_status: current
document_status: current
translation_status: source-only
last_verified: 2026-09-23
owners:
  - maka-backend
---
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

# Maka MCP runtime architecture

状态：remote 与 stdio dual-era V3 implemented（2026-08-25，见已完成的 [#1650](https://github.com/apache/maka/issues/1650)）

跟踪：[MCP post-V3 roadmap #4329](https://github.com/apache/maka/issues/4329)

## 1. 目标与边界

Maka 的 MCP 接入必须复用现有 `MakaTool` execution boundary，而不是建立第二套 agent loop。MCP manager 负责连接、发现和调用；runtime adapter 把远端 tool 投影成动态 `MakaTool[]`。因此 MCP tool 复用 ToolRuntime 的 pre-implementation recording、abort、telemetry、result normalization 和 loop gate；这不代表当前普通路径存在 per-call PermissionEngine，也不代表每次调用都具有 durable T1/T2。

当前支持：

- local `stdio` 与 remote Streamable HTTP 都可选择 legacy、自动协商或精确 pin `2026-07-28`；legacy SSE 只允许 legacy。
- 旧配置省略 `stdio.protocol` 时仍只启动一个 legacy server。用户显式选择 stdio `auto` 或 `2026-07-28` 后，官方 SDK 才获准先启动同 command/args/cwd/env 的一次性探测进程，再在探测进程完全退出后启动实际 server。
- 自动 transport 仅在 Streamable HTTP 尚未产生协议证据、SDK 返回精确 404/405 not-implemented 分类且调用未 abort 时，才 fallback 到 legacy SSE。
- `tools/list` pagination、tool call timeout 和 abort；legacy 使用 unsolicited `notifications/tools/list_changed`，modern 使用经 server acknowledgement 的 `subscriptions/listen`。
- modern server 未声明 tools capability 时不发送 `tools/list`；list-change 由 Maka 做 bounded/coalesced refresh，不把 SDK auto-refresh 作为第二份 snapshot authority。
- modern Streamable HTTP 对 SEP-2243 `x-mcp-header` 做 bounded validation；非法定义只排除对应 Tool，unsafe integer argument 在发送前本地失败。
- text、image、audio、embedded resource、resource link content；MCP `isError` 进入 Maka error path。
- workspace-scoped `mcp.json` 使用 version 3；version 1/2 wrapper 读取时保持各自 legacy 语义，只有显式 mutation 才迁移落盘。
- 首页侧边栏「扩展 > MCP」模块只展示已配置连接，提供搜索、JSON import、添加、编辑、启停、测试、删除和 OAuth 登录；通过 Module Hub services/controller 接入客户端能力。
- 页面不内置第三方服务目录或品牌资产；用户按服务文档添加本地命令或远程 URL。保存后由 mcp.json 表示连接配置；连接失败保留配置，用户显式停用或删除。

若以后恢复「发现」目录，条目必须对应提供方公开文档中的 MCP endpoint，并经过实际连接、传输方式与 OAuth 验证；目录仍只预填配置，不成为安装状态。默认使用文字名称。第三方图标入库前须逐项确认来源、版权许可、发行包所需通知和商标使用条件；开源图形许可不能代替商标授权。ASF 的[第三方作品要求](https://www.apache.org/legal/src-headers.html#3party)、[第三方许可政策](https://www.apache.org/legal/resolved.html)和[项目品牌职责](https://www.apache.org/foundation/marks/responsibility)是审核依据。

当前 rollout 不包含 resources UI、resource subscription 和给 subprocess 使用的 loopback proxy。协议层保留 transport 和 content contracts，后续按独立 PR 扩展。

## 2. 调研结论

### 本地桌面客户端

逆向调研的成熟桌面客户端使用官方 MCP SDK，并支持 stdio、Streamable HTTP、SSE fallback、tools、resources/templates、resource notifications/subscription 和 OAuth 2.1 + PKCE。值得采用的是 transport fallback、分阶段 timeout、stderr tail 和丰富 content block；不采用 stop-all/start-all refresh、base64 token fallback、未经约束的 stdio env inheritance 和不完整的 JSON Schema 转换。

### 开源 agent 客户端

调研的开源实现使用 centralized client pool，backend 共享 source connection，并通过 stable proxy tool name 暴露 tools。它的 stdio validation（单 process、idle watchdog、hard ceiling、stderr tail 和具体错误诊断）值得采用。Maka 不照搬其 sensitive-env denylist、缺少 SSE、把 result 全部扁平化为 text，以及只比较少数字段的 config reconciliation。

## 3. 组件与数据流

```mermaid
flowchart LR
  UI["Desktop Module Hub / TUI"] --> Mutation["updateMcpConfiguration"]
  Mutation --> Store["mcp.json 文件事务"]
  Store --> Manager["客户端 McpClientManager"]
  Manager --> Snapshot["generation-bound tool snapshot"]
  Snapshot --> Provider["Desktop / TUI capability provider"]
  Provider --> Host["Runtime Host admission / execution"]
  Host --> Relay["客户端 relay"]
  Relay --> Manager
  Manager --> Transport["官方 SDK: stdio / Streamable HTTP / SSE"]
```

- `@maka/core/mcp`：无 I/O 的配置、状态、工具契约和凭据退休条件。
- `@maka/storage/mcp-config-store`：配置唯一持久化入口；共享 mutation 在文件锁内执行配置标准化、端点策略检查、凭据退休和原子写入。
- `@maka/mcp`：每个客户端持有自己的 manager，负责 transport、发现、调用及 OAuth 凭据协调。Desktop renderer 不持有 client 或 child process。
- `@maka/runtime/mcp-tools`：schema、content 和工具名称投影，保留原始 server/tool identity 与 generation binding。
- Desktop Module Hub controller：读取配置与状态、发起用户操作，抵御过期请求和默认 Host 切换；Desktop adapter 是 bridge 接缝。
- Runtime Host：唯一的 Session、Turn、continuation、授权准入和执行终态权威。客户端发布 capability offer 并接受 relay 调用，不创建第二条执行链路。

## 4. 配置 contract

```json
{
  "version": 3,
  "mcpServers": {
    "filesystem": {
      "enabled": true,
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": {},
      "cwd": "/tmp",
      "protocol": "auto"
    },
    "remote-service": {
      "enabled": true,
      "url": "https://mcp.example.com/mcp",
      "transport": "streamable-http",
      "protocol": "auto",
      "headers": {}
    }
  }
}
```

Server id 是稳定 identity。配置 reconciliation 使用完整 normalized config fingerprint；新增/删除/修改只影响对应连接。`protocol` 可出现在 stdio 或 remote config，省略始终表示兼容旧配置的 legacy。手动新建连接默认显式写 `auto`；编辑已有配置时保留其协议偏好，SSE 则收敛为 legacy。

version 1、缺失 version 或 version 2 的 wrapper 可单向读取为 version 3 projection，但 `get()` 不静默改写文件；`transform`、`upsert` 或 `remove` 才持久化 version 3。version 1 不接受任何 `protocol`，version 2 只接受 remote `protocol`，version 3 才允许 stdio `protocol`。当前客户端遇到显式未知/未来 wrapper 或 malformed JSON 必须拒绝，不能用一次导入绕过原文件的读取失败并覆盖其原始字节。Desktop renderer 只提交原始 JSON；main process 在 storage normalizer 内解释 wrapper/direct-map、与当前配置合并并持久化，因此导入和正常写入不会形成两套 schema authority。remote headers 仍位于 `mcp.json`，文件和目录分别强制 `0600`/`0700`；后续迁移到 Keychain-backed credential store。

每次 store 写入（包括同值更新）都会在同一原子文档中更新内部 `_makaWriteRevision`；规范化读取和导入不暴露该字段。取消补偿在共享文件锁内检查原事务版本，再执行凭据清理和配置恢复，因此其他 controller 或进程的新写入不会被旧补偿覆盖。版本保护覆盖整份文档：即使后续写入只修改其他 server，也会拒绝旧补偿；TUI 报告 `rollback-failed` 并同步当前磁盘配置。缺少版本字段的外部写入同样使旧事务失去补偿权。

stdio `protocol` 不只是 wire-format 偏好，也是进程副作用授权：

- `legacy`（包括旧配置省略字段）直接启动一个实际 server，不产生探测进程。
- `auto` 先启动一次性 sibling probe；若 command 支持 modern，则等待 probe 退出后再启动 actual child；否则 SDK 按 legacy 连接。探测进程的 stderr 被忽略，不能污染 actual child 的诊断。
- `2026-07-28` 同样使用 sibling probe，但只接受 modern；不匹配时失败，不启动 actual child。

探测和实际连接的协议判断由官方 SDK client v2 独占。Maka manager 只传递偏好、持有当前 actual transport，并在 abort/timeout 时关闭 candidate；它不复制 probe 状态机、不维护 PID registry，也不缓存另一份 negotiated-protocol truth。

手动添加通过 create 写入同一个 `mcpServers` map；ID 已存在时返回字段错误，不覆盖旧连接。JSON import 则保留其明确声明的同名更新语义。

## 5. 安全与权限

- stdio 默认只继承运行所需 allowlist：`PATH`、`HOME`、`USER`、`LOGNAME`、`SHELL`、`LANG`、`LC_*`、`TMPDIR`、`XDG_*` 和 Windows system variables。配置中的显式 `env` 最后覆盖。
- 普通配置型 MCP tool 默认为 `categoryHint: network_send`，用于 trace 分类和 Plan-mode exclusion；它本身不是用户审批机制。`readOnlyHint` 是不可信的 server advisory，不能降低这个分类。受信任的 host composition 可以显式选择更严格的 category/recovery policy，但该 authority 来自 Maka composition，而不是 server annotation。
- Direct/Code Mode 的 managed execution 在 provider dispatch 前由 runtime adapter 检查 `ExecutionBoundary`；network 尚未启用时必须先通过 `requestSandboxBoundary`。协议协商只改变 manager 内部 wire codec，不能绕过这条授权路径。
- manager 只提供 generation-bound tool snapshot 和远端调用。ToolRuntime 总是在 implementation 前投影 `tool_call` / `tool_start`；只有 host 配置 `runtimeCommitSink` 时，才要求 durable T1 在 provider side effect 前成功，并在结果后写 T2。没有 sink 的路径不得声称拥有 durable operation id 或 T1/T2 recovery authority。
- main-process store boundary 对 IPC payload 做 runtime validation，不接受 prototype keys、空 command、非 HTTP(S) URL、非法 headers/env。
- stdio credential 优先走显式 env，不进入 process args。当前显式 env 仍受 owner-only 文件边界保护，不能等同于 encrypted secret storage。
- 普通工具名以 `mcp__{serverId}__{toolName}` 投影；超长、字符替换或分隔符歧义时使用独立的 `mcp_h__` 前缀和原始二元组的稳定 hash suffix，避免不同工具被清洗为同名。原始 identity 用于路由，投影名不作为 MCP server 的工具名。升级前涉及已改名工具的中断任务可能因 tool catalog mismatch 暂停自动恢复；历史保留，用户可发起新 turn。名称只由 identity 决定，不随同批工具的增删变化。
- rich output 对 model text、image count/总 base64 大小和 summary block 数量做 aggregate bounds；audio、resource blob 和 unknown payload 不直接注入 model context。

## 6. Lifecycle 与错误语义

每个 server 只有一个 active connection promise，避免并发重复 spawn。manager 在 candidate 创建时就持有取消权：即使 SDK 的 remote `server/discover` 或 stdio sibling probe 尚未消费 caller signal，abort 也会关闭 candidate transport，不允许迟到握手继续产生网络或进程行为。stdio probe 必须先完全退出，actual child 才能启动；connect 失败必须关闭半连接 client/transport；disconnect 并发启动 subscription、client 和 transport teardown，不能先等待一个可能永不返回的远端 cancellation response。

modern tool-list subscription 只有在 server 声明 capability 且 acknowledgement honor 对应 filter 时才成为 live refresh source。missing、rejected、unhonored 或 non-local close 会进入独立 subscription diagnostic，但不会伪装成 transport disconnect，也不会丢弃上一份可调用 tool snapshot。普通 client/tool 错误不能冒充 subscription 错误；refresh 与 subscription diagnostics 使用独立生命周期槽，成功 refresh 只清除 refresh failure，reconnect 才重建两者。

每个 connection generation 只有一个 `ToolDiscoveryState`。initial discovery、显式 refresh、legacy notification 与 modern subscription signal 都推进同一个 change epoch，并共享同一个 in-flight promise；只有仍拥有当前 client、generation、discovery state 和最新 epoch 的 transaction 才能发布。发布结果仍是唯一的 immutable `ToolSnapshot { revision, tools }`，subscription、status 和 renderer 都不维护第二份 callable registry 或 revision。

Desktop 和 TUI 共用 `updateMcpConfiguration`：先验证完整下一份配置，再在同一文件锁内退休被删除、端点变更或静态 OAuth 注册变更的凭据，最后发布配置。撤销失败则不写文件；已完成的部分撤销可以重新登录恢复。目录 durability fence 失败时，调用方重新读取配置并同步 manager，保留原始 commit-unknown 结果，不重放副作用。Desktop 还在同一进程操作 lane 内排除活跃 OAuth 登录与配置变更的交错；TUI 保留自己的配置 revision 和 Host publication 语义。

OAuth 协议发现、PKCE、注册、交换和刷新由官方 SDK 实现。静态客户端在 `oauth.issuer` 下绑定 `clientId` / `clientSecret`；旧静态配置缺少 issuer 时拒绝授权，用户可在编辑表单补齐。凭据记录绑定 endpoint 和静态注册配置指纹，重启后也会拒绝复用配置不匹配的 token 或注册；缺少指纹的旧静态凭据需要重新登录。Desktop loopback listener 只检查请求来源、路径和 state，完整成功/错误响应交给 manager，先由 SDK 校验 issuer，再接受代码或已知错误码；远端 error_description 不进入页面或 IPC 错误。浏览器回调页面只确认收到响应，真正结果显示在连接详情中。

凭据协调器保留 version CAS 与持久化 revocation generation：前者隔离过期写，后者防止退出授权、删除或跨进程撤销后旧 flow 恢复凭据。登录支持取消、超时和重启后恢复；这些生命周期不能由 renderer 的 busy 状态代替。

timeout 默认值：remote connect 30s、stdio connect 60s、list 15s、call 10min。caller abort 优先于 timeout。协议 `isError` 转为带 server/tool context 的异常；modern `input_required` 不由 manager 自动满足或重试；transport/timeout/validation 分别保留可诊断 message，stdio error 附带最多十行经过 redaction/truncation 的 stderr tail。

配置或 tool-list 变化后，客户端重新发布 capability snapshot，由 Host 管理准入、generation 和后续执行。旧的工具 binding 不能调用新的连接 generation。connected 状态只展示本次实际协商出的 era/revision，connecting、error 和 disconnected 不复用过期协商结果。

## 7. 当前验收标准

1. stdio fixture 可完成 connect → paginated discovery → call → structured content projection → disconnect。
2. `isError`、timeout、abort、startup failure 和经过 secret redaction 的 stderr diagnostics 有自动化覆盖。
3. config store 能拒绝非法输入、并发写不损坏、POSIX mode 为 `0600`。
4. tool name 在 64 chars 内稳定、无 collision；不可信 annotations 无法降低普通 MCP tool 的 `network_send` 分类或让它进入 Plan mode，model output aggregate bounds 有测试。
5. Desktop 首页侧边栏仅在「扩展」分组下提供「技能」和「MCP」；MCP 模块可搜索已配置连接、JSON import、添加、编辑、启停、测试和删除 server，状态与 tools 可见。
6. 重复 ID 不覆盖，连接失败不删除已保存配置；needs-auth 有登录入口，登录可取消，授权后可退出。表单明暗主题和窄窗口下只保留一个可见 modal，字段在同一列对齐。
7. 更新配置后新 turn 看见新 tools，删除后 tools 消失。
8. 受影响的配置、OAuth、工具投影与控制器测试，以及 workspace typecheck/build 和对应 Storybook play 必须通过；Electron 测试仅用于确实需要其进程边界的行为。
9. remote legacy/auto/exact pin、modern missing-tools、structured JSON、`input_required`、窄 SSE fallback 和无响应 probe cancellation 有真实 HTTP fixture 覆盖。
10. modern subscription acknowledgement、initial-list race、burst coalescing、独立 diagnostics、non-local close 和无响应 cancellation teardown 有真实 SDK/event-bus fixture 覆盖。
11. SEP-2243 定义 partition、bounded warning、safe integer 和 wire 前失败有自动化覆盖；legacy 路径不误启用 modern header 语义。
12. stdio 省略 protocol 只启动一个 legacy child；`auto`、legacy/modern exact pin、probe/actual 顺序、probe stderr 隔离，以及 probe 前或进行中的 abort 都有真实 child-process fixture 覆盖。

## 8. 后续路线

Post-V3 工作继续围绕 credential custody、resources/templates、受控 subprocess 复用、server health 与可信分发推进。具体完成状态和剩余交付只在 tracker 中维护，避免本文形成第二份会漂移的 checklist。

跟踪：[MCP post-V3 roadmap #4329](https://github.com/apache/maka/issues/4329)
