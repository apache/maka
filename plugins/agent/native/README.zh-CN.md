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

# maka-agent-native

[English](README.md)

[`HistoryCheckpointPublisher`](src/checkpoints.rs) 是供可信装配层使用的内部
历史 checkpoint 协调器。它绑定原生 Session 命名空间与完整的原始
`RecoveryRef`，调用 Root 持有的捕获、发布及恢复实现，不注册服务方法或
模型工具。后续服务适配器必须经过 Host 准入，并根据持久发布回执完成原
操作；调用方不能自行指定权限作用域。Workspace 捕获及恢复启动不属于此 API。

`agent.fork` 捕获源会话版本和显式 `position`：`end`、带逻辑 Turn ID 的 `through_turn` 或 `before_turn`，以及表示空历史的 `start`。`before_turn` 排除目标完整轮次，指定第一轮可创建空对话。Host 在复制事务中从规范历史计算边界，客户端无需寻找上一轮或依赖采样的历史导航点。返回的分支保留该位置，源会话保持不变。

将 Agent 执行暴露为原生应用服务。`provide` 注册工厂，`executor` 和 `workhub` 连接执行与协调领域。包声明和产品组合决定激活哪些工厂，以及如何绑定导入。

服务管理自己的激活，并委托 `maka-agent-engine` 执行运行。会话历史、控制和工具调用使用获准作用域与原始操作回执。文件、进程、技能等服务都是通过组合显式选择的依赖。

会话摘要和目录项通过 `parentSessionId` 返回创建来源：发起创建的 Agent 会话，或定时任务新建执行会话的来源会话。客户端直接创建时没有父会话。Host 从调用上下文记录这一不可变来源，与 fork 的 `branch` 血缘、任务归属和权限分开；向已有会话派活不会修改它。

服务工具通过 `target: { kind: "import", name: "files" }` 选择导入服务，通过 `target: { kind: "export", name: "agent" }` 选择当前 Agent 自身的 API。自身 export 不增加导入或启动依赖，发布成功后才可调用。两种目标共用 Host 准入、操作回执和可选的 `confirmation` 审批。Maka 通过这条路径开放 Session 浏览、历史、创建、分叉、元数据、归档／删除、消息、队列和执行控制；schema 直接来自已有的 [Agent 契约](../api/src/contract.rs)。

启用工作区指令时，选中的全局 `AGENTS.md` 正文紧接内置身份介绍，仅用 `<global_instruction>` 和 `</global_instruction>` 包裹。优先使用 `~/.maka/AGENTS.md`，只有它不存在时才使用 `~/.agents/AGENTS.md`。其他全局和项目指令文件放在后面。指令在受理时捕获，恢复运行时保留原内容。Native 全局指令 API 读取和保存选中的完整 UTF-8 文件，提示词捕获不设独立的文件大小门槛。保存会检查选中的来源与内容 revision，再原子替换文件；助手编辑器使用共享的完整文本编辑与捕获路径。

新指令按业务 Root 保存的语言偏好、组合配置语言、原生环境的顺序选择英文、简体中文或繁体中文；显式「自动」使用原生环境。一次策略快照同时决定内置指令、技能包装、默认摘要及运行指引的语言。工具 schema 保持英文，用户、自定义及外部内容保留原文。

排队工作、重试、恢复调用及已批准的 Goal／计划任务链保留接收时的语言。新消息、通知及独立接收的标题／回顾请求使用当前偏好；标题和回顾仍要求按用户语言输出。压缩保留复用的 Main 前缀，仅对新生成的包装文字选择语言。持久记录的语言默认英文，英文记录省略该字段；中文使用完整的 `zh-CN` 或 `zh-TW` 标签。

历史回答和思考保留各步骤请求的模型，以及提供方报告的模型（若有）。历史和原文片段在切换模型、复制及重启后保留这些证据。界面将未获报告的模型标为请求模型，将导入记录的模型标为导入来源；外部执行器输出不推断模型身份。

[独立公共 client 验收](../../../products/maka/cli/src/acp/tests/public_client.rs)使用真实公共 Host、Agent 和可控 HTTP 模型，不经过 ACP、TUI 或 GPUI 适配器。它检查固定边界的历史分页、watch 游标继续、所有客户端断开后保留的待回答问题，以及重连回答后停止原 invocation。现有 fixture 提供原 endpoint 与 epoch；重连不会重新发送消息。接入说明见[公开契约入口](../api/README.zh-CN.md)。

```sh
cargo nextest run -p maka-cli --bin maka -E 'test(independent_public_agent_client_reconnects_history_watch_and_pending_interaction)'
```

Agent 接收消息时保存模型的 Code Mode 默认值或显式 `codeMode` 覆盖设置；排队消息和恢复运行保留原模式。服务工具可以通过 `nestable: true` 允许代码内调用，仍执行与直接调用相同的权限检查、操作回执和清理流程。JavaScript 收到声明的业务结果，持久日志保留原生操作的原始回执。省略该字段时仅允许直接调用。Maka 默认组合为文件、进程、Web 和 Skills 工具启用嵌套调用。

模型设置通过 `codeModeLanguage: "javascript" | "python"` 独立选择语言，`codeMode` 控制是否启用，默认语言仍为 JavaScript。Python 使用随包提供的 Monty 解释器，支持顶层 await、`asyncio.gather`、JSON 工具参数和相同的输出/存储辅助函数。消息接收时固定语言，排队和恢复运行沿用原选择；修改只影响新提交的消息。该设置不改变 `maka code`、插件 JavaScript 或 Computer Use REPL。

可通过全局/项目级 `.maka/mcp.json`、`.agents/mcp.json` 或安装配置 `mcpServers` 接入 MCP；项目文件启动前须经用户确认信任。支持 stdio 与 Streamable HTTP，并复用直接调用和 Code Mode 的权限、审批与日志路径。详见 [MCP 配置与信任边界](../mcp/README.zh-CN.md)。

Maka 默认组合启用 `toolDiscovery`：可选工具通过 `tool_search` 加载说明，并在同一 Host 会话内跨轮保留。Code Mode 在说明尚未加载时仍可调用已授权的嵌套工具。消息接收时保存发现策略，恢复运行时沿用原策略。已加载工具说明和 Code Mode 的 `store`/`load` 值按会话隔离、保存在内存中，Host 重启后清空；上下文压缩成功提交后重置已加载的工具说明。

独立的模型覆盖项 `applyPatch` 选择补丁编辑或 Write/Edit 结构化编辑。与 Code Mode 一样，GPT、DeepSeek 模型及 DeepSeek 端点默认启用；排队消息和恢复运行保留接收时的选择。筛选依据是实际绑定的 Files 契约和方法，工具改名不影响策略。读取工具保留，文件操作仍检查实时权限。连接设置的模型覆盖 JSON 可分别设置 `codeMode` 与 `applyPatch`。

Shell 工具默认接受模型生成的可选 `title`。助手偏好可关闭后续模型请求中的标题参数；已有调用的完整参数仍保留在模型历史中。标题用于历史展示，仅在转发给进程服务时移除；未提供标题时显示命令。

Maka 默认组合启用 `todo`：`todo_read` 和 `todo_write` 维护当前会话的持久清单，也可用于 Code Mode 和只读工作区。写入会校验版本并替换整个列表。UI 显示已报告的进度和只读「清单」面板，以有界分页浏览最多 200 项。清单完成状态是模型报告的进度，不代表操作已成功的执行证据。

Maka 默认组合启用 `bot`，即 Bot 模式。`openBot` 返回本安装唯一的 Bot 会话：首次使用或上一个已归档时，在指定工作区中创建。创建会话之前先认领登记记录，所以并发和重试的打开请求都会收敛到同一个会话。这条登记记录是判断 Bot 身份的唯一依据：工具授予、恢复和 `SendUser` 都以它为准，因此 fork 出来的会话和从 Bot 派生的会话都是普通会话。Bot 会话创建时只带 Agent 自带的协调类工具（定时任务、目标、历史检索、清单、WorkHub 委派和技能），`SendUser` 和 `sleep` 由身份授予，不依赖这份工具列表；普通创建不能申请它们。`sleep` 没有参数也没有时长：它结束本轮，之后由用户消息、WorkHub 结果或到点的定时事件各自开启新一轮来唤醒 Bot。只有当排队消息已经注定在运行中调用的下一步送达时才会拒绝休眠，并且必须单独调用，不能和 `SendUser` 放在同一步。每次调用都把消息写入由 Host 持有、与 Run 状态分开的存储，每次调用、每条消息各一条记录：同一 `messageId` 且内容相同视为重复，不会再次记录；同一 id 但内容不同会被拒绝；什么都不发也是合法结果。调用记录不会被淘汰，所以复用的 id 总能被识别。`botOutbox` 按序号游标从旧到新分页读取消息，`watchBotOutbox` 在消息头变化时发出通知。Bot 会话排队的唤醒，包括定时和 WorkHub 来源的消息，在工具结果未知后仍会继续：告知模型，而不是重放工具；普通会话保持更严格的规则。

Maka 默认组合启用 `automaticTitles`。通过 `automaticTitle: true` 创建的会话在首条消息获准后，使用该消息选定的模型发起一次有界、独立计费的标题请求。显式命名、手动改名（包括保留原占位名称）、归档及托管会话保留原名称。重试和 Host 重启不会重复已接收的标题尝试；Host 关闭会等待请求实际清理完成。

自动标题的准备、模型及无效输出失败会持久记录到会话诊断。空响应或输出达到上限时，保留实际请求用量，同时记录标题生成失败。服务停止及策略性跳过不报告标题失败；持久化或清理结果不确定时，保留原有恢复优先级。

模型准备和 OAuth 刷新失败在原始原因被转换为公开错误前写入 Host 警告。警告包含安全错误分类及已有的连接／会话标识（若可用），不包含凭据、配置、请求内容或任意 provider 错误文本。再次读取已失败的刷新结果不会重复记录原始失败。队列及辅助请求的致命错误会记录安全 Host 诊断，并关联可用的 owner、原调用或请求身份。诊断区分会话隔离与 owner 关闭；恢复与资源保管仍遵循原有规则。

模型上下文总容量、独立输入上限与压缩阈值随模型选择一起保存，排队和重启后继续使用接收时的值。未显式设置压缩阈值时，使用已知输入容量的 85%；输出预留仍由引擎单独计算。

默认组合启用 `recaps`。「会话回顾」命令读取缓存；生成新回顾前需明确确认所选模型及可能产生的费用。每次最多扫描 256 个有界历史页，保留不超过 32 KiB 的历史文本，输出上限为 1,024 token，生成限时 30 秒。读取缓存也检查隐私模式和会话访问范围。刷新和原始操作恢复不会重新生成；结果未知的请求在重启后仍保留为待定。辅助用量归属于原始应用操作，关闭时等待模型请求实际清理完成。

默认组合启用 `goals`。`/goal` 或输入框加号菜单打开目标面板；`/goal 目标内容` 直接开始。目标复用现有会话队列自动续跑，不设迭代上限。`CreateGoal`、`GetGoal` 和 `GoalStatus` 可从 Direct 和 Code Mode 调用；每次模型请求都携带当前目标、进度和预算，压缩后仍可读取。模型创建的目标将当前轮作为第一轮。暂停停止当前工作，继续使用所选模型与设置，取消只作用于此目标。临时执行失败允许恢复。Token 预算为可选的跨轮调度阈值；缺失计量如实显示为用量不完整，不会因此停工，用户可以调整预算。读取提供实时用量、剩余预算和累计执行时间；完成并清理后，用量不再随普通聊天增长。重启保留原始操作身份与回执，Host 交接沿封存的后继执行恢复，避免重放操作。隐私模式、归档会话或执行前提变更时，需要用户处理后继续。

默认组合启用 `plans`。「计划」命令可将空闲会话切到规划模式：工具仅允许检查、提问和 `SubmitPlan`，不允许修改工作区或自主委派。提交提案结束当前轮，不会执行。批准展示的提案时固定计划内容、所选模型、工作区和权限边界，实施进入原有 Agent 队列。`update_plan` 也可从 Code Mode 报告所有固定步骤，但只有全部步骤完成或跳过、执行成功且实际清理完成后，计划才算完成。显式继续保留计划内容和进度，并重新取得授权；取消只作用于该计划的原始调用。持久决策、有界只读历史和原始审批回执在重启后保留；过期权限边界和隐私模式阻止新的执行。

WorkHub 协调会话可以选择 Graph 或 Swarm。Graph 决策与原 WorkHub 任务记录原子提交；原任务所有者继续负责派发、依赖输入捕获、控制回执和清理。五个 Graph 工具提供已发布目标、工作／结果／历史的有界读取、更新和让出执行。Swarm 在需要处理或整批工作结束时唤醒协调者。跨轮次输入必须引用较早已完成轮次选定的最终结果；输入采用 16 KiB 结果预览，完整结果仍可分页读取。停止、排队和重启后仍检查原会话、轮次和权限边界。

WorkHub 任务和 Graph 通知在历史中保留其记录的来源，并使用独立的消息标签。

WorkHub 任务按受理时间从新到旧排列。任务详情包含记录的标题和受理时间，状态变化和重启不会改变它们。分页游标保留实时列表中的位置；刷新首页可查看较新的任务。

可复用的 WorkHub 预设保存明确的连接和模型。普通及 Graph 新任务按当前设置解析该目标，无关的连接编辑不会使预设失效。已受理任务保留接收时的模型选择和工具，修改或禁用预设不会重写它们。新路由在受理前明确报告预设、连接或模型不可用。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)
