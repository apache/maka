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

Maka 使用官方 Rust MCP SDK（`rmcp`）接入 stdio 与 Streamable HTTP 工具服务器。原生 Agent 在激活时发现工具，再通过同一工具目录、审批流程和持久化日志提供直接调用、工具发现及两种 Code Mode 语言的访问。

## 通用配置文件

Maka 支持带 `mcpServers` 对象的严格 JSON，用户目录和工作区选择沿用 `AGENTS.md` 的规则：

| 范围 | 选择顺序 |
| --- | --- |
| 用户级 | `~/.maka/mcp.json`、`~/.maka/.mcp.json`、`~/.agents/mcp.json`、`~/.agents/.mcp.json` |
| 项目级 | 当前会话所选工作区根目录的 `mcp.json`，其次 `.mcp.json` |

用户目录来自 Agent 配置的 `assistant.home`。不向父目录搜索。每个范围只读取首个存在的文件；空服务器对象会遮蔽回退文件，文件无效或不可读时报错，不继续回退。文件必须是所选目录内的普通文件，最大 1 MiB。关闭工作区指令不会关闭 MCP 加载。

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

用户文件在 Agent 激活时加载。项目文件必须先由用户确认信任，之后才能连接或启动服务器。在终端发送消息时会展示配置路径、命令或地址、环境变量与请求头来源、预批准和只读权限，并保留草稿。点击 **信任此配置** 后再发送草稿。其他客户端可通过 `projectMcp` 查询和 `trustProjectMcp` mutation 使用相同流程；模型身份不能授予信任。

信任持久绑定所选工作区身份、路径和配置版本。文件变更后需要重新确认。新消息使用新确认的工具目录；已经排队的消息继续使用原连接。不同工作区即使配置同名服务器，也保持独立项目目录。目前不提供专门的连接编辑器。

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

服务器名为 1–32 个 ASCII 字母、数字、下划线或连字符。公开工具名为 `mcp__<server>__<tool>`；服务器名中的连字符和远端工具名的其他字符转换为下划线。转换后重名，或显式选择的工具不存在，都会使激活失败。JavaScript 可调用 `tools.mcp__local_docs__search({...})`，Python 可调用 `await tools.mcp__local_docs__search({...})`。

省略 `tools` 表示允许该服务器已发现的全部工具；空列表表示不公开工具。`readOnlyTools` 显式信任指定远端工具可用于只读会话与计划。服务器的 `readOnlyHint` 无权授予此权限。`preapproved` 默认 false，每次调用需要确认；显式预批准仍须通过会话工具与工作区权限检查，等待批准后也会重查实时权限。计划模式仍要求显式只读信任。

安装 MCP 服务器意味着信任它。stdio 服务器以 Host 用户身份运行，不受会话文件系统沙箱限制，也可能在工具调用之外访问本机。HTTP 服务器自行控制文件系统、网络与外部效果。Maka 权限限制允许发起的调用，不能沙箱化服务器。安装配置和用户服务器在 Agent 激活时启动；项目服务器在确认信任后的首次使用时启动。两者都早于逐次调用审批。仅安装可信服务器，并仅转发需要的凭据。

日志与 Code Mode 保留完整 MCP `CallToolResult`，包含 `content`、`structuredContent`、`isError`、annotations 和 metadata；文本、图片和音频同时进入既有模型输出投影。`isError: true` 保留为服务器报告的工具错误。资源链接仅保留引用，不自动下载。服务器描述、schema 和返回文本均是不可信内容。

## 生命周期与限制

每条已捕获连接的工具 schema 保持固定。收到工具列表变更通知后，目录停止接受新调用；需重新激活 Agent 获取新目录。每个新协议会话使用新绑定身份，之前排队的工作不能静默转到新服务器；重新激活后请提交新消息。安装或用户服务器启动失败会使 Agent 激活失败；项目服务器启动失败会拒绝新消息，并显示服务器名，不会静默略过。启动清理未确认时，本次激活不再启动新的项目服务器，关闭时也会保留此错误。

每次调用仅发送一次，不自动重放，也不自动恢复过期协议会话。超时或取消会发送取消通知，并退役未结算的连接。stdio 清理等待本地进程组终止；缺少终态结果仍表示外部效果未知。HTTP 断连无法证明远端工作已停止，因此清理结果保持未确认。对于效果未知的操作，先检查外部系统，再决定是否重试。关闭 Agent 会关闭所有持有的连接。

服务器配置与工具发现不设固定数量、页数或字节配额。工具发现持续读取到分页结束，并拒绝重复游标。stdio 消息、HTTP JSON／错误响应体与 SSE 事件保留完整内容；取消与连接清理机制继续生效。默认启动超时 10 秒、调用超时 120 秒；可配置范围分别为 1–300,000 ms、1–3,600,000 ms。

当前提供工具接入，不提供 resources/prompts 浏览器、roots、sampling、elicitation、tasks、OAuth 管理或旧版 HTTP+SSE 传输。

## 验证

```sh
cargo test -p maka-mcp
cargo test -p maka-agent-native mcp_native_direct_and_code_mode
```

测试使用真实子进程和 loopback HTTP/SSE 服务器，覆盖分页发现、结果与媒体、环境隔离、大目录与完整的大结果、取消与进程清理，以及直接调用、Code Mode、审批和实时权限。
