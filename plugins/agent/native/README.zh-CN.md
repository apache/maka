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

[`CheckpointPublisher`](src/checkpoints.rs) 将已获准的原生 Session namespace
和原 `RecoveryRef` 绑定到 Root 持有的历史捕获与恢复流程。
[服务适配层](src/owner/checkpoints.rs)通过 Host 准入、原操作回执授权和有界订阅读取提供显式管理方法。
领域回执可确认 checkpoint 成功，但不伪造通用 Host 的清理确认。
参见 [API 工作流](../api/README.zh-CN.md#历史-checkpoint-管理)和[手动性能基线](src/owner/tests/checkpoints/benchmark.rs)。
模型工具和跨 Root 恢复激活不在此 API 范围内；Workspace 与同 Root 恢复见下文。

[检查适配层](src/owner/checkpoints/load.rs)通过相同 Host 管理边界提供精确加载及有界历史、Artifact 查询。加载的历史保留原 ID，放在隔离存储中，不向本 Owner 的执行或消息恢复注册。响应未知时使用原操作及原输入查询 `historyCheckpointLoadReceipt`。Workspace 发布与显式的同 Root 目录恢复分别见 [Session 适配器](src/owner/checkpoints/session.rs)和[恢复适配器](src/owner/checkpoints/restore.rs)。这两者保留条件一致性提示，要求明确的目标权限与模型，不自动发起消息。跨 Root 恢复及系统级外部停写仍未提供，详见 [API 支持范围](../api/README.zh-CN.md#workspace-发布与本地继续执行)。

`agent.fork` 捕获源会话版本和显式 `position`：`end`、带逻辑 Turn ID 的 `through_turn` 或 `before_turn`，以及表示空历史的 `start`。`before_turn` 排除目标完整轮次，指定第一轮可创建空对话。Host 在复制事务中从规范历史计算边界，客户端无需寻找上一轮或依赖采样的历史导航点。返回的分支保留该位置，源会话保持不变。

将 Agent 执行暴露为原生应用服务。`provide` 注册工厂，`executor` 连接执行领域。包声明和产品组合决定激活哪些工厂，以及如何绑定导入。

服务管理自己的激活，并委托 `maka-agent-engine` 执行运行。会话历史、控制和工具调用使用获准作用域与原始操作回执。文件、进程、技能等服务都是通过组合显式选择的依赖。

会话摘要和目录项通过 `parentSessionId` 返回创建来源：发起创建的 Agent 会话，或定时任务新建执行会话的来源会话。客户端直接创建时没有父会话。Host 从调用上下文记录这一不可变来源，与 fork 的 `branch` 血缘、任务归属和权限分开；向已有会话派活不会修改它。

服务工具通过 `target: { kind: "import", name: "files" }` 选择导入服务，通过 `target: { kind: "export", name: "agent" }` 选择当前 Agent 自身的 API。自身 export 不增加导入或启动依赖，发布成功后才可调用。两种目标共用 Host 准入、操作回执和可选的 `confirmation` 审批。Maka 通过这条路径开放 Session 浏览、历史、创建、分叉、元数据、归档／删除、消息、队列和执行控制；schema 直接来自已有的 [Agent 契约](../api/src/contract.rs)。

内置 `external` 执行器通过 PTY 驱动交互式 Claude Code，通过 ACP 驱动 agy，通过 app-server 驱动 Codex。在 `external.runtimes` 中启用对应 CLI，也可用 `external.commands` 配置程序、参数和环境。请先在原生 CLI 登录。CLI 使用当前账户配置和原工作区，原生工具使用完整权限，回调 Maka 的 MCP 工具仍受会话授权约束。

原生 assistant 输出保留 agy ACP 的轮次和工具身份、Codex item ID 和 Claude API 的 `message.id`。显式消息开始／结束边界让阶段说明、工具和后续回答在实时显示、刷新及取消后保持原生顺序。完成回执只指向最后完成的非空正文消息，不再用整轮聚合文本覆盖此前输出。agy、Codex 和 Claude 的思考内容与最终答复分别保存。

每次任务拥有自己的原生进程、协议流和 Host bridge。Codex 执行使用前台 app-server，发现使用 daemon/proxy。agy 每次 new/resume 都使用 `--dangerously-skip-permissions`；Codex 每次 open/resume 都必须确认 `never` 审批和 `dangerFullAccess`，每轮也传入相同策略。Claude 使用Maka 指定的会话 UUID 和 `--dangerously-skip-permissions`，先启动真正的空白读屏 PTY。Maka 自动处理原生主题、安全说明和绕过权限确认；仅当信任对话框明确指向本轮已获授权工作区的精确 canonical 路径时才确认信任，由 Claude 自己保存决定，不直接改写全局信任记录。登录仍由用户完成。交互提示和本轮 Host MCP 工具目录均就绪后，逐张粘贴 PNG/JPEG/GIF/WebP 上传的不可变临时文件路径，等待原生图片编号确认，再粘贴文字并只发送一次 Enter。JSONL 接纳必须匹配正文、原生图片标签及完整 image block 数量。终端控制字符转为可见形式，CRLF 归一化；Maka 说明通过独立普通 user 消息传入，不覆盖原生系统提示词；原生接入初始化只做一次，已交付说明摘要持久化，内容不变时不重复提交，变更或清空时明确替代旧说明。原生提问／计划回调仍须使用已捕获的 Host 对应工具；未识别的对话框显式失败，不猜测用户答案。当前提示游标之后的完整 JSONL `turn_duration` 记录仅证明轮次结束，还必须排除 `isApiErrorMessage` API 错误才能判成功；Stop hook、终端重绘、静默和进程退出均不能证明完成。

`SessionSend` 默认向正在运行的 Codex、Claude 执行发送 steering；显式 `delivery: "queue"` 和贡献式 service executor 则留到后续 invocation，不打断当前执行。Codex 通过 `turn/steer` 绑定已捕获 thread 和当前 turn 前置条件。Claude 向同一 PTY 继续粘贴输入并按普通 Enter，保留原生忙时输入队列，不强制 send-now、不取消或另起进程。每条已提交 Claude 输入都须由原生 user 行精确确认，才能在最后的 assistant／`turn_duration` 后结算共享 Host invocation；中间 duration 不能丢掉尚未消费的输入。消息身份、发送者来源、原始回执和已捕获的工具上限不变；过时的 Host 交互会关闭，但不代答或代批。等待 ACK 时收到的原生通知在拒绝／取消后仍有明确所有者；明确拒绝的输入不静默算作原生模型已消费，也不重放。

三家都保留原生系统提示词。捕获的 Maka 说明用 `<maka_system_instructions>` 包裹，作为实际任务之前的一条独立普通 user 消息，不拼进任务正文。Codex 通过原生 `thread/inject_items` 追加该消息，不额外启动模型轮次；Claude 在同一 PTY 确认说明消息及其结果后再提交任务，初始化答复不作为用户任务答案。

agy 从原生 `agy models` 读取模型目录，从 `/usage` 读取分组额度。执行通过 [agy ACP](https://antigravity.google/docs/ide/extensions/acp/) 新建或续接会话，使用当前登录的账号和原工作区。建连时直接注册本轮 Host MCP，续接时刷新凭据，工具命名空间保持一致，无需额外工作区或 hook。已有会话沿用原生 ID 和已保存的历史。升级前，请在旧版中让正在运行的 headless 任务完成或停止并结算。Maka 说明在首次交付或变更时通过独立的 user 消息发送，图片通过 ACP image block 传入。工具摘要、思考片段和本轮用量随执行事件记录。

停止时向 agy 会话发送 `session/cancel`，等对应 prompt 返回终态后再结算任务。agy 忙时，steer 会在同一事务里将新消息入队，并请求取消当前轮。原轮结算后沿用同一个原生会话处理后续消息。显式 queue 会让当前轮继续执行。无法确认原始终态时，恢复仍按原任务绑定读取其协议日志。

原生协议帧、Claude JSONL 行及经过认证的 Host MCP 请求共用 256 MiB 内存防护边界，不另外限制上传大小或图片张数。20 张各 5 MiB 的图片编码为同一行 base64 就已约 134 MiB。ACK 前事件不再按条数截断，保留预算同样为 256 MiB，每条至少按 1 KiB 计入对象开销。启动和 RPC 确认允许五分钟，Claude 文字确认和 JSONL 接纳还按每 32 KiB 增加一秒。这不是整轮执行时限；用户仍可取消，清理超时和不确定副作用栅栏独立保留。

首次启动原生会话时，Maka 提供之前的会话历史。后续续接只在需要时提供上次交付之后的增量历史。Codex 发现沿原生游标完整分页。

`maka.agent.external` 按 Maka 会话、运行时和命令/工作区保存原生会话 ID、已交付的指令摘要和最后交付的 Run。Host 重启后可以续接下一轮。中断任务仍按单次任务的原始绑定恢复，绝不重新提交原输入。

macOS 上的 `cargo test -p maka-cli --test external_jobs` 用可控 app-server 验证原工作区、原生续接、精确停止和冷启动恢复。

外部运行时只获得已捕获的安全 Host catalog：Skills、结构化提问、支持的 Session 编排、插件管理及符合条件的 Recall 工具。调用保留实时 Maka 身份、授权、审批、ToolJournal 和原操作回执。取消时先关闭准入、请求取消并等待全部已准入副作用结算，再结算原生进程和输出流。Session 工具列表只约束这一 Host catalog；CLI 保留原生工具和完整权限模式。

桥接的 Files `Read` 只接受 Session 附件和归档结果资源，包括有界的 `page.next` 分页；拒绝工作区文件、任务资源和图片输出。较大的 Host 结果仍可通过相同的归档资源路径读取。此桥接不开放 CUA、Session 元数据／归档／删除、Goal 和定时执行工具，也不自动转发第三方 MCP 配置。

Windows 命令须选择原生 `.exe`，或显式使用 `node.exe` 加 CLI 脚本参数。`.cmd`／`.bat` 启动脚本会给出明确诊断，不隐式交给 shell 执行。

Host 工具使用会话级本地 HTTP MCP endpoint，同一 Host 激活期间保持地址和私有配置路径稳定。每轮捕获不可变工具定义。本轮工具选择收紧时可保留公开定义以复用缓存，但不可用调用仍会被拒绝；新增工具或定义变化只在上一轮结算后刷新目录，不因描述或插件更新丢失原生会话身份。每个 invocation 使用新 bearer 和隔离的 MCP transport session，不共享调用权限。Codex 刷新 thread 级 `http_headers`；Claude 和 agy 在原配置路径原子刷新凭据。已关闭的凭据和旧 transport session 不能借用下一轮权限；已接受调用在取消或断连后仍归原 invocation 和原操作回执。空闲会话仅保留 endpoint、目录和配置，删除会话及 Host 关闭会在物理结算后释放。Host 重启会创建新 listener 和私有目录，并捕获当前目录，同时保留原生身份、已完成的初始化标记与说明交付摘要。凭据不出现在 argv 或日志中。

启用工作区指令时，选中的全局 `AGENTS.md` 正文紧接内置身份介绍，仅用 `<global_instruction>` 和 `</global_instruction>` 包裹。优先使用 `~/.maka/AGENTS.md`，只有它不存在时才使用 `~/.agents/AGENTS.md`。内置模型会话还会在后面追加其他全局和项目指令文件。外部 Codex、Claude 和 agy 会话只接收 Maka 身份、选中的全局偏好和 Maka 工具／技能说明（以及已配置的 Maka 角色）。CLI 自己发现并加载其原生全局和项目规则；Maka 不再将这些文件复制进注入块，也不关闭原生发现。工作区指令开关只控制 Maka 的采集，不控制 CLI 原生加载。Maka 指令在受理时捕获，恢复运行时保留原内容。Native 全局指令 API 读取和保存选中的完整 UTF-8 文件，提示词捕获不设独立的文件大小门槛。保存会检查选中的来源与内容 revision，再原子替换文件；助手编辑器使用共享的完整文本编辑与捕获路径。

新指令按业务 Root 保存的语言偏好、组合配置语言、原生环境的顺序选择英文、简体中文或繁体中文；显式「自动」使用原生环境。一次策略快照同时决定内置指令、技能包装、默认摘要及运行指引的语言。工具 schema 保持英文，用户、自定义及外部内容保留原文。

排队工作、重试、恢复调用及已批准的 Goal／计划任务链保留接收时的语言。新消息、通知及独立接收的标题／回顾请求使用当前偏好；标题和回顾仍要求按用户语言输出。压缩保留复用的 Main 前缀，仅对新生成的包装文字选择语言。持久记录的语言默认英文，英文记录省略该字段；中文使用完整的 `zh-CN` 或 `zh-TW` 标签。

历史回答和思考保留各步骤请求的模型，以及提供方报告的模型（若有）。历史和原文片段在切换模型、复制及重启后保留这些证据。界面将未获报告的模型标为请求模型，将导入记录的模型标为导入来源；外部执行器输出不推断模型身份。

[独立公共 client 验收](../../../products/maka/cli/src/acp/tests/public_client.rs)使用真实公共 Host、Agent 和可控 HTTP 模型，不经过 ACP、TUI 或 GPUI 适配器。它检查固定边界的历史分页、watch 游标继续、所有客户端断开后保留的待回答问题，以及重连回答后停止原 invocation。现有 fixture 提供原 endpoint 与 epoch；重连不会重新发送消息。接入说明见[公开契约入口](../api/README.zh-CN.md)。

```sh
cargo nextest run -p maka-cli --bin maka -E 'test(independent_public_agent_client_reconnects_history_watch_and_pending_interaction)'
```

Code Mode 默认开启。Agent 接收消息时保存生效的 `codeMode` 设置；排队消息和恢复运行保留原模式。服务工具可以通过 `nestable: true` 允许代码内调用，仍执行与直接调用相同的权限检查、操作回执和清理流程。JavaScript 收到声明的业务结果，持久日志保留原生操作的原始回执。省略该字段时仅允许直接调用。Maka 默认组合为文件、进程、Web、Skills、部署与 UI 插件管理以及 Session／Model 协调工具启用嵌套调用，内置的清单、Goal、Recall、定时任务和 Bot `SendUser` 同样支持代码内调用；由模型提供方远程执行的工具、结束轮次的工具（`sleep`）、Computer Use REPL 工具和 `AskUserQuestion` 保持仅直接调用。

模型设置通过 `codeModeLanguage: "javascript" | "python"` 独立选择语言，`codeMode` 控制是否启用，默认语言仍为 JavaScript。Python 使用随包提供的 Monty 解释器，支持顶层 await、`asyncio.gather`、JSON 工具参数和相同的输出/存储辅助函数。消息接收时固定语言，排队和恢复运行沿用原选择；修改只影响新提交的消息。该设置不改变 `maka code`、插件 JavaScript 或 Computer Use REPL。

可通过全局/项目级 `.maka/mcp.json`、`.agents/mcp.json` 或安装配置 `mcpServers` 接入 MCP；项目文件启动前须经用户确认信任。支持 stdio 与 Streamable HTTP，并复用直接调用和 Code Mode 的权限、审批与日志路径。详见 [MCP 配置与信任边界](../mcp/README.zh-CN.md)。

Maka 默认组合启用 `toolDiscovery`：可选工具通过 `tool_search` 加载说明，并在同一 Host 会话内跨轮保留。Code Mode 的工具定义不随发现结果变化。在 Cell 内用 `ALL_TOOLS` 查找并调用已授权的嵌套工具。消息接收时保存发现策略，恢复运行时沿用原策略。已加载工具说明和 Code Mode 的 `store`/`load` 值按会话隔离、保存在内存中，Host 重启后清空；上下文压缩成功提交后重置已加载的工具说明。

独立的模型覆盖项 `applyPatch` 选择补丁编辑或 Write/Edit 结构化编辑。GPT、DeepSeek 模型及 DeepSeek 端点默认启用；排队消息和恢复运行保留接收时的选择。筛选依据是实际绑定的 Files 契约和方法，工具改名不影响策略。读取工具保留，文件操作仍检查实时权限。连接设置的模型覆盖 JSON 可分别设置 `codeMode` 与 `applyPatch`。

Shell 工具默认接受模型生成的可选 `title`。助手偏好可关闭后续模型请求中的标题参数；已有调用的完整参数仍保留在模型历史中。标题用于历史展示，仅在转发给进程服务时移除；未提供标题时显示命令。

Maka 默认组合启用 `todo`：`todo_read` 和 `todo_write` 维护当前会话的持久清单，也可用于 Code Mode 和只读工作区。写入会校验版本并替换整个列表。UI 显示已报告的进度和只读「清单」面板，以有界分页浏览最多 200 项。清单完成状态是模型报告的进度，不代表操作已成功的执行证据。

Maka 默认组合启用 `bot`，即 Bot 模式。`openBot` 返回本安装唯一的 Bot 会话：首次使用或上一个已归档时，在指定工作区中创建。创建会话之前先认领登记记录，所以并发和重试的打开请求都会收敛到同一个会话。这条登记记录是判断 Bot 身份的唯一依据：工具授予、恢复和 `SendUser` 都以它为准，因此 fork 出来的会话和从 Bot 派生的会话都是普通会话。Bot 会话创建时只带 Agent 自带的协调类工具（定时任务、目标、历史检索、清单和技能），`SendUser` 和 `sleep` 由身份授予，不依赖这份工具列表；普通创建不能申请它们。`sleep` 没有参数也没有时长：它结束本轮，之后由用户消息或到点的定时事件各自开启新一轮来唤醒 Bot。只有当排队消息已经注定在运行中调用的下一步送达时才会拒绝休眠，并且必须单独调用，不能和 `SendUser` 放在同一步。每次调用都把消息写入由 Host 持有、与 Run 状态分开的存储，每次调用、每条消息各一条记录：同一 `messageId` 且内容相同视为重复，不会再次记录；同一 id 但内容不同会被拒绝；什么都不发也是合法结果。调用记录不会被淘汰，所以复用的 id 总能被识别。`botOutbox` 按序号游标从旧到新分页读取消息，`watchBotOutbox` 在消息头变化时发出通知。Bot 会话排队的唤醒，包括定时消息，在工具结果未知后仍会继续：告知模型，而不是重放工具；普通会话保持更严格的规则。

Maka 默认组合启用 `automaticTitles`。通过 `automaticTitle: true` 创建的会话在首条消息获准后，使用该消息选定的模型发起一次有界、独立计费的标题请求。显式命名、手动改名（包括保留原占位名称）、归档及托管会话保留原名称。重试和 Host 重启不会重复已接收的标题尝试；Host 关闭会等待请求实际清理完成。

自动标题的准备、模型及无效输出失败会持久记录到会话诊断。空响应或输出达到上限时，保留实际请求用量，同时记录标题生成失败。服务停止及策略性跳过不报告标题失败；持久化或清理结果不确定时，保留原有恢复优先级。

模型准备和 OAuth 刷新失败在原始原因被转换为公开错误前写入 Host 警告。警告包含安全错误分类及已有的连接／会话标识（若可用），不包含凭据、配置、请求内容或任意 provider 错误文本。再次读取已失败的刷新结果不会重复记录原始失败。队列及辅助请求的致命错误会记录安全 Host 诊断，并关联可用的 owner、原调用或请求身份。诊断区分会话隔离与 owner 关闭；恢复与资源保管仍遵循原有规则。

每个逻辑请求按当前模型观测解析上下文总容量和独立输入上限；排队和重启后继续保留接收时的用户覆盖参数。未显式设置压缩阈值时，使用已知输入容量的 85%；输出预留仍由引擎单独计算。

默认组合启用 `recaps`。「会话回顾」命令读取缓存；生成新回顾前需明确确认所选模型及可能产生的费用。每次最多扫描 256 个有界历史页，保留不超过 32 KiB 的历史文本，输出上限为 1,024 token，生成限时 30 秒。读取缓存也检查会话访问范围。刷新和原始操作恢复不会重新生成；结果未知的请求在重启后仍保留为待定。辅助用量归属于原始应用操作，关闭时等待模型请求实际清理完成。

默认组合启用 `goals`。`/goal` 或输入框加号菜单打开目标面板；`/goal 目标内容` 直接开始。目标复用现有会话队列自动续跑，不设迭代上限。`CreateGoal`、`GetGoal` 和 `GoalStatus` 可从 Direct 和 Code Mode 调用；每次模型请求都携带当前目标、进度和预算，压缩后仍可读取。模型创建的目标将当前轮作为第一轮。暂停停止当前工作，继续使用所选模型与设置，取消只作用于此目标。临时执行失败允许恢复。Token 预算为可选的跨轮调度阈值；缺失计量如实显示为用量不完整，不会因此停工，用户可以调整预算。读取提供实时用量、剩余预算和累计执行时间；完成并清理后，用量不再随普通聊天增长。重启保留目标迭代原有的已接纳 Run 与 Host 回执身份；恢复对账该 Run 的效果及物理清理，后续迭代仍须由领域策略授权新提交，不是物理执行交接或原请求重放。归档会话或执行前提变更时，需要用户处理后继续。

## 主动发现

启用 `bot` 和 `scheduledTasks` 后，当前 Bot 可通过 `ScheduledTask` 提议
`effect: "discovery"`。与其他模型创建的定时任务一样，提议保持暂停，直到用户通过
`schedule` 批准其精确工作区、权限和模型。用户直接创建时使用 `discovery` 效果，
以当前 Bot 为目标。沿用 `once`、`interval`、`cron` 定时及 `trigger_now`、`pause`、
`resume` 控制；默认不会启用任何调查。
留空 `intentBody` 时，worker 从可访问的材料中自主寻找值得关注的方向；填写后围绕该方向做专题调查。

每次触发新建一个普通 worker Session，使用已批准的工作区、模型和权限。
工具及权限检查沿用普通会话，包括已配置的 Shell、网页工具和 MCP。
调查会话还可调用 `DiscoveryMemory` 和 `DiscoveryComplete`。此前批准的只读计划在重新批准前
保留原工具范围。worker 必须调用 `DiscoveryComplete`，提交 `{"kind":"no_report","note":"检查了什么"}` 或
`{"kind":"report","text":"发现及来源"}`。调用持久记录结果并结束本轮；只输出普通文本
属于未完整提交调查结果。

所有调查共用一个执行位，等待报告交接时也占位。调度器等待真实执行清理结束，不把接纳
当作完成。`no_report` 静默结算；报告通过已有通知路径只向 Bot 接纳一次，由 Bot 判断
是否调用 `SendUser`。运行记录链接到 worker，并区分“报告已接纳”和“用户已收到”。
暂停会取消原 worker Run，并撤回尚未消费的报告；已消费的 Bot 消息保留为历史。
重启时在队列消费者启动前重新检查原来源授权与待处理触发，按原 Run 和回执恢复，
不新建替代调查。被中断并终结的执行记录为失败。

停用 Bot 或调度会撤销尚未结束的调查与未发送报告。恢复计划只安排后续工作，不恢复
已取消的那次触发。结算按原调查 Run 跟踪，因此用户之后在同一 Session 中开展的工作
不会继续占据调查位。结果写入不确定时保留工具结果未知状态。

计划、当前调查及已完成回执复用调度器 KV 命名空间，不增加独立数据库或租约。
`DiscoveryMemory` 在同一 Bot 来源边界内，为新 worker 共享调查结果、进度、修正、通知决策
和用户反馈。Bot、工作区、权限版本或 Recall 授权变化后使用不同记录范围；引用不授予读取权限。

调查开场提供可用的上一轮记录，以及已授权工作区目录中最多六条会话的引用，仅包含 ID 和时间。
`get` 返回完整记录。
`list` 每页最多返回四条简短预览，每次最多检查 32 个位置；即使筛选后为空，也通过
`next_before` 明确提供后续入口。支持按文本或原调查记录筛选。修正以关联记录追加，不覆盖
原内容。调查结果、完成回执、顺序索引与调查位释放在同一事务提交。`checkpoint` 暂存一条
有界进度，Host 恢复后继续保留；成功或失败结算时发布，取消时舍弃。记录描述观察与执行结果，
不代表任务已核验完成。

Bot 可在 `SendUser` 或 `sleep` 中附带 `discovery: {record, reason}`，同一个模型步骤完成
通知或不通知的决策记录。通知记录必须关联实际已保存的 outbox 消息。如果消息已经保存，但
决策确认失败，工具保留结果未知；用同一消息 ID 重试不会重复发送。重启本身不代表未知效果
或资源清理已经结算，仍沿用 Agent 的原执行核对与风险裁决规则。`DiscoveryMemory` 也支持
单独记录决策和修正。`feedback` 将 Bot 的理解关联到本轮真实用户输入，不能把 worker 通知当作
用户反馈。原文和引用保留在原消息，通过分页 `feedback_source` 按需读取。`send` 支持可选的
不可变 `quotes`，包括只有引用没有正文的消息，并沿普通发送及 steering 链路保留。原生 Bot
使用这条链路；外部执行器仍遵守原有富输入限制。引用不会授予原会话访问权。

本阶段不导入 TS 主动发现数据，也不接入外部事件监听。
[调查测试](src/owner/driver/tests/model_recovery/discovery.rs) 使用真实 Host 和本地模型夹具验证。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)


ChatGPT 订阅请求使用 Host 拥有的[账号模型目录](src/model/codex_inventory.rs)。
每个逻辑模型 step 准备时检查五分钟有效期的兼容性缓存；同连接共享按需发现任务，
发现失败后短暂退避并加入抖动。取消一个等待者不会取消 Host 的共享工作。
每次请求将账号、连接和观测到的 `comp_hash` 记录到 `ModelRequested.context`；
这些是来源事实，不是禁止跨账号回放的条件。目录发现不改变已选择模型。
Host 重启后先获取自己的账号观测，再记录兼容性证据。

已受理消息保存当时的模型、思考和工具策略、模型覆盖参数及请求 body 控制，不把目录解析出的容量当作用户配置。
之后修改默认设置或显示信息，只影响后续接收的消息；当前消息的每一步及重启恢复继续使用已经捕获的用户选择。
执行前仍检查 Provider 身份、连接是否可用、凭证授权及实际传输路由。
每个逻辑请求用同一次当前模型观测准备 context、能力、选项和输出预算；物理重试继续使用已冻结请求。
因此目录变化本身不会使排队或恢复的任务失效。

Goal 调度不再解析无需调度且无待处理操作的执行授权，并隔离无法读取的记录，避免单条记录阻止其他 Goal 继续。
跨会话 `Recall` 检索与 `catalog` 分页同样隔离无法读取的会话元数据或历史源事件（记入 `gaps` 或跳过目录项，不保留旧格式解码分支），单会话定向查询仍直接返回错误。
新消息在共享模型发现完成后，按当前设置受理。

ChatGPT 冷缓存或到期刷新在逻辑请求准备时等待，后台压缩的 capture 也遵循此策略；并发调用共用 Host 持有的请求。
270 秒启动刷新，为 300 秒目录 TTL 留出 30 秒余量。每次发现有 15 秒超时；账号替换可能先等待旧任务结算，再等待新账号发现，
因此不是整个模型请求最多等待 15 秒。失败后使用现有模型执行，不新增兼容性证明，
随后随机退避 30–60 秒以免请求风暴。缓存有效或处于退避期时不等待目录网络请求；凭证解析沿用自己的既有策略。这些数字是本地延迟与负载策略，
不是协议限制。TTL 只管理新目录观测，已记录的来源事实与检查点不会随缓存到期。捕获完成后，提前压缩继续与 Main 并行执行。

连接默认使用文字摘要压缩。模型连接设置仅在提供商配置 schema 声明 `serverSideCompaction` 时显示
**提供商服务端压缩**开关，按连接保存；目前 ChatGPT 订阅支持此功能。
开启后，手动和自动压缩使用 Responses 原生 `compaction_trigger` 控制项。
只有生产流完整结束且存储验证同一来源边界和生产请求后，引擎才安装不透明 checkpoint。
后续请求回放该 checkpoint 与保留的后续历史；再次压缩会替换基线。
会话、全局和一次性文字压缩提示词仍可编辑、保存，但不进入 ChatGPT 原生压缩请求。
关闭开关时，文字压缩提示词正常生效。原生检查点和普通加密思考共用基于 hash 的回放准入，可跨订阅账号。
不兼容原生状态会在推理前被拒绝；自动转换与小窗口切换预检留待后续实现。

订阅 Provider 仅在连接开启该选项时，在解析后的能力中选择原生压缩。关闭后仍可回放已有原生 checkpoint；下一次压缩生成文字摘要。Host 冻结一个协议操作，Responses 适配器负责追加触发命令，
并只在流完成时返回有类型的 `NativeCompaction`。Engine 和 EventLog 无需再从 provider options JSON 提取结果。
检查点头部只保留来源步骤引用、内容摘要和 token 估算，baseline 读取时从原始请求派生 producer/model。

关闭新增权限申请会保留已有有效授权，可以在 Run 执行中生效。开启申请需要会话空闲，因为运行中的 Run 保留原始授权上限。修改基础访问权限或明确撤销授权才会推进权限边界。
