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

# MCP 工具

Maka 使用官方 Rust MCP SDK（`rmcp`）接入 stdio 与 Streamable HTTP 工具服务器。原生 Agent 发现已配置的工具，再通过同一工具目录、审批流程和持久化日志提供直接调用、工具发现及两种 Code Mode 语言的访问。

## 通用配置文件

在**设置 → MCP 服务器**中选择全局配置或项目，然后通过表单添加本地命令或 Streamable HTTP 地址。参数逐项填写；高级选项包括工作目录、环境变量和 HTTP 请求头。对应文件里的已有服务器均可编辑和删除，不要求由 Maka 添加。保存会保留其他服务器和未知 JSON 字段；文件已被其他操作修改时，需要刷新后再保存。

Maka 从以下四个位置读取含 `mcpServers` 对象的 JSON，优先级从高到低：

| 范围 | 文件 |
| --- | --- |
| 项目 | `<workspace>/.maka/mcp.json` |
| 项目 | `<workspace>/.agents/mcp.json` |
| 全局 | `~/.maka/mcp.json` |
| 全局 | `~/.agents/mcp.json` |

用户目录来自 Host Agent 配置的 `assistant.home`；项目使用已选择并验证的工作区，管理配置无需创建会话。不向父目录搜索。同名条目整体覆盖低优先级服务器，不同名的低层条目仍然保留；空文件不会屏蔽低层配置。文件无效或不可读时报告错误。工作区指令偏好不影响 MCP 加载。

```json
{
  "mcpServers": {
    "docs": {
      "command": "node",
      "args": ["./server.mjs"],
      "env": {"DOCS_MODE": "local"}
    },
    "remote": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headerEnv": {"authorization": "MCP_AUTHORIZATION"}
    }
  }
}
```

同名服务器按“安装配置 → 用户文件 → 项目文件”整项覆盖；`{"disabled": true}` 可禁用继承的服务器。文件条目接受 `command`、`args`、`cwd`、`env`、`passEnv`，或 `url`、`headers`、`headerEnv`，以及下方示例中的工具选择、只读权限、预批准和超时字段。传输方式可根据 `command` / `url` 推断，显式 `type` 支持 `stdio`、`http`、`streamable-http`、`streamable_http`。不支持旧式 SSE、JSONC 或 `${…}` 环境变量展开；引用 Host 环境变量请使用 `passEnv` / `headerEnv`。

文件中省略 `cwd` 时使用配置文件所在目录；相对 `cwd` 以该目录为基准。`./.venv/bin/mcp` 等相对可执行路径以最终 `cwd` 为基准，裸命令通过 `PATH` 查找；参数按字面值传递。

新调用读取当前文件。项目文件必须先由用户确认信任，之后才能连接或启动服务器。在终端发送消息时会展示配置路径、命令或地址、环境变量与请求头来源、预批准和只读权限，并保留草稿。点击 **信任此配置** 后再发送草稿。其他客户端可通过 `projectMcp` 查询和 `trustProjectMcp` mutation 使用相同流程；模型身份不能授予信任。

信任持久绑定所选工作区身份、路径和配置版本。文件变更后需要重新确认。新消息使用新确认的工具目录；已经排队的消息继续使用原连接。不同工作区即使配置同名服务器，也保持独立项目目录。后台工作在消息实际接纳时选择 MCP 目录；已接纳的消息和等待审批的调用保留原连接。被替换的连接在没有已接纳工作引用后关闭。

## 安装配置

在产品 `installation.json` 的 `agent.mcpServers` 中配置服务器，再按[安装说明](../../../products/maka/bundle/README.zh-CN.md)生成并激活。已有安装可在[插件组合编辑器](../../../products/maka/cli/README.zh-CN.md)中修改 Agent 实例的 `configuration.mcpServers`，保存后重新激活 Agent。安装配置的默认列表为空。

以下片段合并进已有 Agent 配置；路径和服务器地址需要替换：

```json
{
  "mcpServers": [
    {
      "name": "local_docs",
      "transport": {
        "type": "stdio",
        "command": "/absolute/path/to/mcp-server",
        "args": ["--stdio"],
        "cwd": "/absolute/path/to/data",
        "passEnv": ["DOCS_API_KEY"]
      },
      "tools": ["search", "read_document"],
      "readOnlyTools": ["search", "read_document"],
      "preapproved": false,
      "startupTimeoutMs": 10000,
      "callTimeoutMs": 120000
    },
    {
      "name": "remote",
      "transport": {
        "type": "streamable_http",
        "url": "https://mcp.example.com/mcp",
        "headerEnv": {"authorization": "MCP_AUTHORIZATION"}
      },
      "tools": ["search"]
    }
  ]
}
```

Host 环境变量 `MCP_AUTHORIZATION` 应包含完整请求头值，例如 `Bearer …`。`headers` 设置字面量请求头，`headerEnv` 从 Host 环境读取值。不要把凭据放进 URL。HTTP 使用 Host 的代理设置且不跟随重定向；当前不提供 OAuth 登录或自动令牌刷新。

stdio 直接执行命令和参数数组，不经过 shell；`cwd` 必须为绝对路径。默认只继承 `PATH`、`HOME`、`USERPROFILE`、`SystemRoot`、`WINDIR`、`TEMP`、`TMP`、`TMPDIR`、`LANG`、`LC_ALL`。其他变量通过 `env` 或 `passEnv` 显式提供。服务器程序需要自行安装，Maka 不负责下载。仅使用 Node 的服务器与测试夹具需要 Node。

## 工具名、信任与结果

服务器名使用 ASCII 字母、数字、下划线或连字符。公开工具名为 `mcp__<server>__<tool>`；服务器名中的连字符和远端工具名的其他字符转换为下划线。转换后重名，或显式选择的工具不存在，都会使激活失败。JavaScript 可调用 `tools.mcp__local_docs__search({...})`，Python 可调用 `await tools.mcp__local_docs__search({...})`。

省略 `tools` 表示允许该服务器已发现的全部工具；空列表表示不公开工具。`readOnlyTools` 显式信任指定远端工具可用于只读会话与计划。服务器的 `readOnlyHint` 无权授予此权限。`preapproved` 默认 false，每次调用需要确认；显式预批准仍须通过会话工具与工作区权限检查，等待批准后也会重查实时权限。计划模式仍要求显式只读信任。

安装 MCP 服务器意味着信任它。stdio 服务器以 Host 用户身份运行，不受会话文件系统沙箱限制，也可能在工具调用之外访问本机。HTTP 服务器自行控制文件系统、网络与外部效果。Maka 权限限制允许发起的调用，不能沙箱化服务器。安装配置中的服务器在 Agent 激活时启动；文件配置的服务器在请求其工具目录时启动，项目配置须先确认信任。两者都早于逐次调用审批。仅安装可信服务器，并仅转发需要的凭据。

日志与 Code Mode 保留完整 MCP `CallToolResult`，包含 `content`、`structuredContent`、`isError`、annotations 和 metadata；文本、图片和音频同时进入既有模型输出投影。`isError: true` 保留为服务器报告的工具错误。资源链接仅保留引用，不自动下载。服务器描述、schema 和返回文本均是不可信内容。

## 生命周期与限制

每条已捕获连接的工具 schema 保持固定。收到工具列表变更通知后，目录停止接受新调用；需重新激活 Agent 获取新目录。每个新协议会话使用新绑定身份，之前排队的工作不能静默转到新服务器；重新激活后请提交新消息。安装配置的服务器启动失败会使 Agent 激活失败；文件配置的服务器启动失败会拒绝请求，并显示服务器名，不会静默略过。启动清理未确认时，本次激活不再启动新的文件配置服务器，关闭时也会保留此错误。

每次调用仅发送一次，不自动重放，也不自动恢复过期协议会话。超时或取消会发送取消通知，并退役未结算的连接。stdio 清理等待本地进程组终止；缺少终态结果仍表示外部效果未知。HTTP 断连无法证明远端工作已停止，因此清理结果保持未确认。对于效果未知的操作，先检查外部系统，再决定是否重试。关闭 Agent 会关闭所有持有的连接。

服务器配置与工具发现不设固定数量、页数或字节配额。工具发现持续读取到分页结束，并拒绝重复游标。stdio 消息、HTTP JSON／错误响应体与 SSE 事件保留完整内容；取消与连接清理机制继续生效。默认启动超时 10 秒、调用超时 120 秒；配置的超时必须为正数。

当前提供工具接入，不提供 resources/prompts 浏览器、roots、sampling、elicitation、tasks、OAuth 管理或旧版 HTTP+SSE 传输。

## 验证

```sh
cargo test -p maka-mcp
cargo test -p maka-agent-native mcp_native_direct_and_code_mode
```

测试使用真实子进程和 loopback HTTP/SSE 服务器，覆盖分页发现、结果与媒体、环境隔离、大目录与完整的大结果、取消与进程清理，以及直接调用、Code Mode、审批和实时权限。
