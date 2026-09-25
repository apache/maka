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

# Maka 插件 SDK

[English](README.md)

供可信 Rust Host 插件使用的 TypeScript 合同。Host SDK API **1** 独立于 Maka 应用版本；此 workspace 尚未发布。

```ts
import type { HostPlugin } from '@maka-agent/plugin-sdk/host';

const activate: HostPlugin = async (ctx) => {
  await ctx.tools.register<{ text: string }>(
    {
      name: 'Echo',
      description: '返回传入的文本。',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
    },
    ({ text }) => ({ text }),
  );
};
export default activate;
```

打包为不含 import 和顶层 await 的单个 ESM 入口。在 `maka.extension.json` 中声明 `runtime: { entry: "index.mjs", sdkVersion: 1, vm: "shared" }`；`dedicated` 为该包当前加载代申请独立 VM。

Prompt 回调接收类型化的 Session 或模型步骤上下文，不伪造工具调用权限。section 和动态 context 默认解析模板；已解析内容或用户文本使用 `format: 'plain'`。一个 `complete` section 替换其它提示词 Contribution，不删除显式 Session／子任务指令。物理重试复用同一份冻结组合。

`ctx.background.pending(name, wake)` 在插件仍有工作时阻止 Host 空闲退出。空闲后关闭注册；重新激活时恢复持久意图并重新注册。它不授予权限，也不阻止显式关闭或升级。系统唤醒回调串行执行、合并重复通知，接收取消信号，并可关闭自己的注册。Rust 插件发布同一 `BackgroundWork` Contribution，以同步投影报告待办状态；仅使用 `ctx.run` 不会让 Host 常驻。

Prompt 回调通过 `call.workspace`、输入准备通过 `request.workspace` 取得有界的目录只读视图。视图随回调结束失效，不能写入、执行命令、越过工作区或保留给后台工作。`ctx.inputs.names()` 列出显式挂载的非敏感输入；`ctx.inputs.at(name)` 提供相同的 read/list 接口，只开放选定文件或子树并随插件退休失效。默认允许边界内的符号链接；`symlinks: 'reject'` 可拒绝末端链接，挂载白名单也约束链接目标。

`view.openFile({ path })` 固定普通文件及打开时的长度。`info` 包含长度与修改时间；`read({ offset, limit })` 每次至多读取 1 MiB，不包含后续追加内容。路径替换不会重定向句柄，但原地修改仍可见，需要多遍一致性的格式由消费者校验摘要。固定前缀内截断会明确失败。Rust `PinnedFile::with_reader` 在阻塞线程批量执行相同的有界读取；每批检查当前授权，回调结束或 Fiber 退休会关闭文件。`close()` 等待实际释放，每个获准根目录最多持有 32 个文件。

`ctx.behaviors.register(name, prepare, { nativeInput: 'native_user_messages' })` 显式允许向同一包与作用域管理的模型会话发送原生用户消息，默认值为 `denied`。Host 在准入前检查当前行为注册与调用方权限；注册退休或替换会使在途准备失效。该策略保留原生消息 ID、附件、显式选择、队列位置与回执，不开放管理器专属的配置、修订或恢复操作；受管理会话的原生消息不能覆盖编排模式。

`call.files.entries` 与 `ctx.data` 共用有界字节／目录操作：read、write、list、stat、createDirectory、sync、remove 和禁止覆盖目标的 rename。路径必须相对根目录，不跟随链接，父目录需已存在；写入支持 `createNew` 和普通权限位。读取／列目录观察退休信号，已准入写入继续结算。事务与崩溃恢复由插件负责。`{ kind: 'directory', path }` 授权只允许文件访问，不创建工作区标记；目录被替换后授权失效。`withAuthorization(id, (call, grant, boundary) => ...)` 同时提供当前授权的观察信息。只读视图的 `location()` 用于展示或提出授权申请，不授予路径访问权限。

显式 `network` 授权独立于文件／进程沙箱：只读工作区可以使用 Host HTTP，但不会因此获得文件写入或进程权限。Agent HTTP 仍需自己的执行授权。重启恢复时重新检查当前授权；撤销后拒绝新请求。

每次 Agent 工具或 Executor 调用捕获当前权限边界。Session 权限变更只影响新调用，不升级已有调用上下文或进程。Service 转发保留原边界；过期上下文不能发起新操作，已接受的工作仍完成结算。

已结束但结果不确定的操作记录为 `unknown` 并明确返回，后续恢复调用仍可继续。持久化事实缺失或资源清理未确认才关闭准入；捕获 SDK 异常不能隐藏这些故障。

Remote 的 Session／工作区视图通过 `files` 提供相同接口。读取会重新检查当前凭据与工作区绑定，纳入 Remote 调用的资源结算，并随回调结束失效。序列化的工作区路径仅用于观察，不是访问授权。

`caller.views.queryDatabase({ path, queries })` 通过 `host_paths` Remote 端点读取明确的受信任 Host SQLite 路径。整批查询共用一个读取事务，正确读取 WAL，关闭后才完成结算。Host 数据目录不可访问，当前凭据与 Session 作用域仍有效；不保证抵御同用户恶意并发替换路径。整数以十进制字符串、二进制以 base64 无损传递。只允许读取类内置函数与 schema 查询，不允许修改或加载扩展；上限为 16 条语句、250,000 行、64 MiB 编码结果，工作量与超时采用协作检查，不是 OS 隔离。

`ctx.tools.bind(definitions, capture)` 在每个逻辑模型步骤为一组工具冻结实现及可选上下文。capture 回调获得工作区只读视图，返回 `null` 表示本步不提供该组工具。模型返回的调用使用已冻结的闭包，不重新采样实现；关闭注册会一起撤下整组工具。`alwaysVisible` 可让工具无需搜索即对模型可见。

capture 收到不含秘密的 `model`：选定模型 ID、生效的能力和可用的 provider-tool 协议。绑定可为自己注册的名称返回 `providerTools: { Research: { id: 'openai.web_search', args: {} } }`，工具直接由主模型请求执行，不调用本地处理器；仅含此类工具的绑定无需 `invoke`。描述、闭包和上下文一起冻结，物理重试不重新采样。供应商工具不能结束 Host Turn，也不能嵌入 Code Mode。

当前 SDK 必须明确将描述识别为供应商执行的工具。未知 ID 或要求本地执行的供应商工具在网络请求前拒绝，不会被静默省略。

- 激活阶段暂存注册；通过 `ctx.run` 在发布生效后启动业务循环。用 `ctx.effect` 注册清理，观察 `ctx.signal`。
- Tool 和 Executor 回调获得绑定调用身份的服务与进程能力。旧调用句柄会失效；实例级进程需通过下一次调用的 `processes.open(id)` 重新绑定，卸载时由 Host 清理。
- 启动进程使用冻结的工作目录、沙箱及已批准的额外权限，以及绝对可执行路径和 argv。不支持的隔离在启动前拒绝。默认随调用结束；重新绑定实例进程或 PTY 时，当前权限必须覆盖其启动策略。stdin 字符串按 UTF-8 编码；输出用 `TextDecoder` 增量解码。
- `call.terminals` 使用同样的命令与生命周期约定，提供原生 PTY、串行输入／尺寸变更回执、带明确 reset 事件的有界输出，以及持久退出和清理结果。后续调用需重新打开实例级终端；卸载会关闭它们。终端解析复用 Host 的共享 VM，不按 PTY 分配。
- `call.permissions.request({ reason, permissions })` 为 Agent 工具或 Executor 申请额外文件／网络权限。Host 在审批前解析路径；受保护资源仍不可访问。返回的批准子集不是能力令牌，每次操作仍检查当前授权。Executor 没有工具调用身份，只能获得 Turn/Session 授权。独立 Remote／后台工作使用显式授权。
- `call.http.request` 使用 Host 代理配置，缺少网络权限时申请批准，不解除文件沙箱。独立调用要求显式 `network` 许可。通过 `response.next()` 分块读取字节；`null` 表示完整结束，截断则报错。调用结束或插件卸载时关闭响应。不自动重试或重定向，远端副作用的恢复由插件负责。
  Host 在发送前记录准入、报告 EOF 前记录结算：Agent 调用进入所属 invocation 日志，独立调用进入 Host effect 记录。传输中断保留未知结果，不视为可以重放的失败。记录请求元数据和正文摘要，不重复保存流式载荷。
- Behavior 准备回调收到受限 Session 配置快照，不代表获得权限。已授权的执行句柄提供 `activity(sessionId)` 和 `stop(invocation)`；控制前保存观察到的精确身份，重试不重新选择目标。`artifact({ operationId, artifactId, offset, limit })` 每次最多读取该执行 Turn 的 64 KiB 产物。
- `resume({ operationId, source })` 恢复一个精确、已封口的模型 Run。重试和 Host 重启后均返回同一规范开场回执；选择恢复哪个来源属于插件业务。准备期间不持有 Host 准入锁。
- `configure({ sessionId, expectedRevision, target })` 用 CAS 修改空闲 Session 的模型／Executor，不改变权限、工作区或行为。`createRoot({ managed: true, ... })` 声明包的管理所有权，不增加资源权限；`plugin_workspace` 授权选择与包数据目录分离的私有工作区。
- Executor 目标接受 `settings: { model?, thinkingLevel? }`；省略表示使用执行器默认值，不指向 Host 模型连接。配置对象整体替换旧选择，回调通过 `request.settings` 接收；这些设置与精确执行器身份在派发前一起提交，配置修改只影响后续执行。
- `ctx.executors.search({ query? })` 发现插件作用域内已注册执行器的 ID、显示名称和声明能力。单页最多 50 项／48 KiB；`complete: false` 时需缩小查询范围。发现不授予执行权限；执行器退休后不再出现在后续查询中。
- `submit` 在接受工作前冻结输入准备。被阻止的输入不创建回执；接受的内容和稳定回执原子提交。Remote 提交使用真实认证连接，不接受插件指定的连接 ID。
- `enqueue({ operationId, messageId, invocation, content, placement })` 向精确的活动 Run 排队，回执跨插件替换和 Host 重启保留。`message(operationId)` 返回待投递、已取消或真实投递归属，并说明是否独占 Turn；`retract(operationId)` 不停止已投递或共享的执行。
- `offerInteraction({ operationId, invocation, prompt })` 发布包范围的问题／表单，Host 标记请求者身份。`waitInteraction` 取消不撤回请求，`closeInteraction` 不能覆盖已提交的回答；该接口不提供权限审批。
- `call.sessions.list({ revision?, cursor?, includeArchived? })` 返回有界元数据分页。Agent 只看到当前 Session；独立调用需要相应范围的 `read_sessions` 授权，目录读取不授予执行权。
- `call.history.list` 使用相同目录格式，包含归档状态和最近消息时间。已准入 Agent 调用可跨 Session 读取受信任 Host profile；Remote／后台调用需要相应范围的 `read_history` 授权。`read({ sessionId, through?, cursor? })` 返回准备进度或固定日志水位下的 UTF-8 文本分块，沿返回的水位和游标读取至 `next` 为 null。每次读取检查当前访问权和来源是否存在，不授予执行权。排序与片段组装属于消费插件。
- Session 范围的执行命令使用稳定 operation ID：相同内容重试返回原收据，内容变化则冲突。profile Entry 不会自动获得 Session 权限。
- `executions.importSession` 使用根会话创建授权暂存历史记录。持久保存 operation ID，按回执中的记录位置追加，再按精确总数发布；相同重试恢复原回执。暂存不出现在 Session 列表，发布重新检查当前权限上限，且必须包含用户或助手对话。上限为 7,500 条、6 MiB 规范材料，每批至多八条；超限明确失败，不发布残缺对话。导入工具仅是历史观察，不执行、不计量。`inspect` 恢复进度；`abandon` 只放弃未发布导入，不删除已发布 Session。
- 按来源顺序分别导入 `tool_call` 和 `tool_result`。适配器在来源 Session 内规范化 `callId`，结果沿用对应键；不为未完成调用虚构结果。
- `call.history.sources({ sessionId, turnId })` 按顺序读取准备前的原始输入，包括已接受的队列编辑和自有附件。最多返回 64 条消息／64 KiB 文本，超限报错，不静默截断。它们不是合并展示行或准入证明；重新提交须使用新身份并重新准备。
- `call.history.copySession(target, { source, root })` 使用独立的根会话创建能力建立自有历史副本。目标须使用同一工作区；受管理来源只能由所属包／作用域复制。持久保存 operation ID 和源 revision 以精确重试；`target.restoreRoot` 可恢复已接受目标，不重放创建。继承历史不赋予源执行权限。
- `target.abandonRevision(operationId)` 仅删除未使用的自有修订。已接受工作会保留会话；重试及重启后返回持久决定。删除草稿只关闭其订阅，不断开连接。
- `readMessage({ sessionId, messageId, cursor? })` 在同一快照中返回精确投递链、终态答复摘要和待处理交互的 ID／类型。沿 `answer.next` 读取最多 16 KiB 的 UTF-8 分页；游标绑定 invocation，执行变化时拒绝混读。交互提示不授予代答或批准权限。
- `executions.submit({ orchestrationMode })` 仅选择该次执行的模式，不改变 Session 默认值。`query()` 的 `attentionId` 标识当前阻塞交互集合或交接暂停，不随无关日志写入变化。
- `call.clients.tools()` 仅列出调用准入时冻结的客户端工具；`call.clients.call({ name, input })` 复用 Host 权限、审批／表单、取消和持久化结算。Model 与 Executor 遵守同一边界，后续发布能力或放宽权限不会扩张它。
- 存储按包和范围隔离，提供 CAS revision 与原子批次。删除保留 revision；业务迁移由插件负责。
- `ctx.credentials` 将按包和范围隔离的秘密写入 Host 私有凭据库，不进入普通存储或执行历史。写入比较 revision，删除保留墓碑。每个值最多 64 KiB，每个命名空间最多 256 个稳定键。沿用现有 vault 的文件权限／ACL 保护，不另加一层加密。
- 仅安装编解码和 URL 全局对象。文件、网络、计时器和进程不是环境自带的 Node API，应使用 Host SDK 服务；不承诺恶意代码隔离。
- `call.files` 提供类型化的 read/write/edit/glob/grep/patch，复用 Host 工具与持久化结算。权限不超过调用准入时及当前 Session 的权限和工具上限。读取返回有界分页或已持久化的图片引用；搜索结果标明完整性。丢弃 Promise 不会丢弃文件操作的收尾责任，跨 Service 转发也保留这一约束。
- `call.llm.generate` 使用调用准入时冻结的模型及 Host 的代理/OAuth，与主模型共享执行器。只发送显式 prompt/system，不携带工具或父对话。默认输出预算 2048 token；输入上限 256 KiB，响应流上限 2 MiB。结果及供应商报告的用量落盘后才返回；缺失用量保持未知。未等待的调用也随调用作用域取消并完成清理。

`npm --workspace @maka-agent/plugin-sdk run typecheck` 同时检查 Rust Host 集成测试实际执行的插件 fixture。

`ctx.preferences.read()` 返回带 revision 的个性化、隐私、工具模式及工作区指令开关，不暴露凭据或完整 Host 配置。激活期间即可读取，随插件退休失效；它不授予资源或执行权限。

`commands.createChild({ ..., workspace: 'isolated_git' })` 为子 Session 绑定 Host 管理的 linked worktree。父会话必须允许写入，且工作目录是干净仓库的根目录。重试与 Host 重启保留子任务改动。执行及工作区写入者结束后，`workspacePatch(operationId)` 发布相对于初始提交的不可变 Git patch artifact，包含已提交与未提交改动，不自动合并到父目录。需在子会话进入下一 Turn 前导出。工作区保留用于恢复，不随插件禁用而删除。稀疏检出、子模块、外部 Git filter 和超过 50 MiB 的补丁会明确报错。Host 的 Git 操作使用 gix，不依赖系统 Git 可执行文件。

输入准备使用 `ctx.input.prepare(name, callback)`，返回不变、附回执的准备文本或明确拒绝。此时没有 invocation 权限，不能替换附件或已有回执；Host 标注来源，已接受输入在重放时不重新准备。回调应无副作用；可变来源更新时关闭并重新注册，阻止旧准备结果继续准入。

`call.clients.notify` 需要明确的通知授权，只选择授权用户的客户端。取消只撤回尚未准入的投递；已准入的投递仍须结算，不自动重试结果不确定的通知。`boundary` 是 Host 解析后的授权边界观测，原提案的路径别名不一定等于解析后的路径。

`application.manage` 和 `navigation.status` 提供应用管理页和导航状态插槽。管理操作携带 ID，消费者调用 `handled()` 确认后不会因页面重新挂载而重复执行。

## Client SDK

若提供 `settings.page.onOpenSession(rawSessionId)`，它通过来源 Host 映射会话 ID；页面、Host 或连接退休后拒绝跳转。

`ctx.slots.register('tool.detail', toolName, Component, { order? })` 替换精确工具名对应的详情内容，使用 Slot 排序中的首个注册。参数包含 canonical Session、Turn、工具调用身份，以及观察到的参数、结果和有界输出；开放 payload 需自行收窄。原生沙箱／恢复操作保留在扩展之外。渲染器缺失、退出或失败时回退到原生详情。

`ctx.slots.register('settings.page', key, Component, { label, order? })` 在设置页选中的 Host 上同时发布页面与导航项。`label` 是字符串或包含 `en`/`zh-CN`/`zh-TW` 的翻译表；组件接收 `locale` 和注册 key 对应的 `page`。切换 Host、连接或注册后，旧选择失效。插件重连不影响原生设置。其他 Slot 接受可选的 `{ order }`。

`application.overlay` 挂载于应用默认 Host；`session.header.actions` 和 `turn.footer` 挂载于所查看 Session 的 Host，接收 canonical `sessionId`。页脚另含 `turnId`，同一可见 Turn 即使包含多次 steering 也只挂载一次，不替换原生操作。Session／Turn 参数用于定位观察，不授予执行权限。

`ctx.events.subscribe({ kind: 'session.changed' }, listener, onError?)` 观察来源 Host 的失效通知。`session.event` 和 `tool.activity` 还须指定该 Host 的 canonical `sessionId`。回调接收可判别的 `ClientProductEvent`；事件 payload 是需自行收窄的开放产品投影。观察流包括实时增量和可能重放的 seed，不是持久 `LogEvent` 或恰好一次回执。订阅随实例发布，释放或退休立即停止投递，不跟随替代连接。插件领域变化使用公共 Remote 流。

Client SDK API **1** 使用 Desktop 提供的 React。导出来自 `@maka-agent/plugin-sdk/client` 的 `ClientPlugin`；其 `activate(ctx, config)` 暂存带 key 的 Slot 注册和 Effect。初始化结束后关闭 Slot 注册；`ctx.effect` 和 `ctx.style` 在激活后仍可注册，释放函数幂等。异步清理在结算前始终归原实例所有，即使已主动释放；清理失败时，该 Entry 必须等待页面重载，不能自动重新激活。

用 `@maka-agent/plugin-sdk/build` 的 `buildClient({ packageId, entryPoint })` 构建（作者的构建环境需安装 esbuild）。保存返回的 JavaScript，并在 manifest 中声明 `client: { entry: "client.js", sdkVersion: 1 }`。加载器在执行前校验字节和 SDK 版本。插件共享可信 Renderer，不是沙箱，也不提供 Node 兼容层。

Slot 包括 `session.composer.before`、`workspace.composer.before`、`workspace.manage`、`application.manage` 和 `navigation.status`。应用操作携带 ID，并要求显式 `handled()` 确认。工作区参数只是候选目标，不是路径授权。Composer Slot 提供只编辑草稿的 `appendText` 和 `publishSuggestions`。发布对象提供 `update(items)` 和 `dispose()`：刷新时更新同一 owner，effect 清理时销毁。条目身份跨刷新稳定；建议随发布者或目标退出而撤下，不提交消息。每个注册拥有 Entry 内唯一 key 和可选数值排序。包导入需列入 manifest dependencies；React、`react/jsx-runtime` 和 Client SDK 由 Desktop 提供，不要重复打包 React。

建议可设置 `tokenLabel`，将 `insertText` 显示为行内 token。标签只影响外观；提交、编辑与恢复仍使用序列化文本。

可选的 `ctx.localFiles.pick()` / `open(path)` 仅处理 Desktop 本地路径，不用于远程 Host 文件。Desktop 在原生操作前校验 Client 发布身份，导航或退休后返回的文件选择结果会被丢弃。

Desktop 通过 `@maka/ui/plugin` 提供共享 UI 模块（目前为 `Button`）。使用该入口支持的组件，不再打包一份组件库实例；它不暴露内部 UI 包的完整 API。

Host 插件通过 `ctx.remote.method(name, callback)` 或 `ctx.remote.stream(name, open)` 发布接口。Client 插件通过 `ctx.remote.method<Input, Output>(name, sessionId?)` 获取调用函数，或通过 `ctx.remote.stream<Input, Output>(name, sessionId?)` 获取异步迭代器工厂。UI 发布后才能调用；句柄固定到原 Host 连接和后端注册，不随替换重定向。退出迭代会关闭流，UI 卸载或页面导航会关闭所属文档。Remote 调用不是 Agent 调用，不隐含进程权限。

Remote 回调可以抛出携带 `RemoteFailure.code` 的 `Error`。`outcome_unknown` 保留业务结果不确定的语义，需要领域恢复，不能盲目重试；它不会隔离已正常结算的插件。资源清理未确认时由 Host 独立隔离。未分类异常映射为 `operation_unavailable`。

每条流只允许一个在途读取。返回或取消会立即中断等待，不必等生产者响应；晚到的打开结果会清理，晚到的数据会丢弃。这只结束观察，不取消 Host 对已接受工作的结算。

认证后的应用也可通过 `{ packageId, method, sessionId }` 绑定 `plugin.remote`，无需加载插件 UI。没有前端的 Rust 提供者使用 `Endpoint::standalone`，JS 提供者仍使用 `ctx.remote` 注册。包绑定固定后端注册，保留文档所有权、取消和授权检查，不获得前端身份，也不绕过 Host 授权。配对的 Client 绑定另外校验包内容，并随 UI 退休。

接受调用者 Host 路径的 Rust endpoint 声明 `Endpoint::requiring_host_paths()`。Host 在绑定和调用时都检查路径授权，借用其他连接的注册目标也不能绕过。项目 ID 和已有 Session 查询不要求原始路径权限；插件通过显式注入的只读视图访问它们。

`ctx.models.search({ query })` 返回已启用的聊天模型、支持的思考程度及默认值，每页最多 50 项／48 KiB；`complete` 为 false 时应缩小搜索范围。`ctx.models.resolve({ kind: 'named', connectionSlug, model })` 返回相同结构的精确模型选择，`{ kind: 'default' }` 解析当前默认模型。两者均不授予执行权限，也不保证提供商当前可用。

`restoreRoot(operationId)` 按当前工作区和来源上限恢复本包／作用域创建的根会话，不依赖原模型；创建记录不会使普通根会话变成独占托管会话。`restoreChild` 要求原始子会话创建请求。两者均不创建资源；不存在的观察不能排除并发创建。`configure` 每次成功选择都会推进 Session revision，包括相同值，以阻止较早的配置 CAS 覆盖它，不修改事件历史。

## 终端应用

Host 插件通过 `ctx.tui.app(name, { read, submit, recover? }, descriptor)` 贡献 TUI 应用，无需 Desktop bundle 或重新编译 Maka。descriptor 选择 `page`、`panel`、`status`、`settings` 或命名 `slot`，上下文为 `application` 或 `session`；视图通过 `tui.slot(...)` 组合其他插件的贡献。

`read(route, cx)` 返回用 `ctx.tui` 构造的 View v5 内容，包括列、行、分栏、标签、文本、Markdown、控件和字段，SDK 自动添加版本。稳定的同级 key 保留焦点与编辑状态；`cx.t(en, zhCN, zhTW)` 选择当前语言。外壳负责布局、本地输入、滚动、确认与草稿恢复；插件使用语义颜色，不输出终端转义序列。

标签组和由 item 组成的列各占一个 Tab 停靠点，方向键在组内移动，重新进入时恢复上次焦点。列表列可包含文本、Markdown、代码、分隔线和进度；字段与按钮放在列表外，保持逐个 Tab 可达。仅移动焦点不会提交动作或进入插件路由。

`submit({ route, revision, action, fields, grant }, cx)` 执行明确的用户操作，返回 `applied`、`conflict`、`rejected` 或 `consent`。使用 revision 做存储 CAS，并在 Host 检查领域权限。只有 `recover(route, cx)` 能查询持久结果时才声明 action 的 `recovery` 路由；外壳不会盲目重放结果未知的写入。

实时刷新使用 `const changed = await ctx.tui.changes('changed')` 注册流，在 descriptor 设置 `changes: 'changed'`，数据提交后调用 `changed()`。失效通知会合并，外壳重新读取干净视图并保留已有草稿；订阅与控件随注册退休。

分页历史与流式文本使用 transcript 资源，复用原生 Chat 的 Markdown、分组、选择与本地搜索，数据不嵌入有 64 KiB 上限的 View：

```js
const key = { turn: 'build-42', message: 'log', part: 'text' };
const log = await ctx.tui.transcriptResource('build-log', {
  blocks: [{ key, revision: '0', kind: 'assistant', content: { text: 'Started\n' } }],
});
ctx.effect(() => log.close());
// Return this node in a view; append when the observed work produces text.
const reader = ctx.tui.transcript('log', log.resource);
log.append(key, 'Finished\n', '1');
```

`replace`、`append`、`remove`、`timing` 发布连续的资源更新，不需重新读取 View。记录 key 与 revision 是稳定的展示身份，不授予原生会话、文件或写入权限；周围的动作仍使用原有授权、CAS 与恢复契约。Ctrl+F 搜索已加载页，End 或新内容标记回到最新位置；选择文本会暂停跟随。

SDK 管理文档范围内的快照、游标与取消。数据源最多保留 4,096 条／32 MiB；一页最多 256 条／4 MiB，单条较大记录可放宽至 16 MiB。大记录用有序 UTF-8 JSON 分片传输，每条消息仍受 Remote 上限约束。更新队列超限会明确使阅读区失效。Rust 插件可通过普通 Remote method/stream 实现同一[公共记录与资源协议](../../crates/plugins/src/terminal_ui/transcript.rs)，资源端点必须属于包含该节点的视图的同一 entry 和 activation。Slot context 应携带稳定实体身份，节点 key 应区分可独立编辑的实体。

[Board 示例](../../crates/cli/tests/fixtures/board-plugin/host.mjs) 展示三列看板、卡片详情编辑、存储 CAS 与实时刷新。[PTY 测试](../../crates/cli/tests/integration/tui/board.rs) 在 TUI 运行期间安装它、执行交互并读回持久领域数据。

## 用量

`session.inspector.overview` 接收当前 Host 的规范 `sessionId` 与 `locale`，补充概览而不替换原生轨迹／上下文控件。Remote 读取应绑定此 Session；插槽参数本身不授予执行权限。

`call.usage.activity({ kind: 'start', filter: { from, to, sessionId?, activity? } })` 读取模型和工具的物理调用，包含失败重试、辅助调用及派发前拒绝。Agent 只读当前 Session；独立调用需要 profile 或 Session 范围的 `read_usage` 授权。结果不包含对话正文，缺失用量、报价和结果分别保持未知。

活动通过 `model`／`tool` 标签区分。可选 `activity` 按 `kind`、`status` 和字面文本 `search` 筛选；搜索仅忽略 ASCII 大小写，最多 1 KiB UTF-8，不接受控制字符。派发前拒绝没有执行耗时；副作用未知不等于取消。

每页最多 100 条／48 KiB。`{ kind: 'continue', cursor }` 重读该页，`nextCursor` 在相同筛选条件与结算快照下翻页。Host 重启使游标失效；每次读取都重新检查当前授权。

`{ kind: 'refine', cursor, selection }` 修改活动筛选并返回首个匹配页，不改变原作用域、时间范围或快照。

`call.usage.summary(cursor)` 复用相同的范围、Session 和快照，忽略活动列表筛选。Token 和费用小计保留缺失调用数；未报价与已报价但用量不完整分别统计。提供商／模型／工具分组必须完整，否则明确报错（各最多 128 组，整体 48 KiB）。待结算数按范围内的准入时间统计，不计入已完成总额。非有限值或无法精确表示的整数会报错，不变成零。

汇总中的 `durationMs` 累加已观测的模型／工具执行耗时，不计未知结果与派发前拒绝。并发调用会累加，不代表会话墙钟时间。

## 报价

`ctx.pricing.query({ kind: 'start' })` 在激活期间即可读取公共报价。使用返回的 revision 与 `nextOffset` 继续分页，遇到 `revision_changed` 则重新读取。`call.pricing.update({ expectedRevision, mutation })` 需要 profile 范围的 `manage_pricing` 明确授权。修改复用原生 CAS 与配置通知，只影响后续准入；已接受的修改不会因调用者停止等待而中断。丢回复后重试可能返回 `revision_conflict`，应先查询再决定下一次修改。

## Behavior 选择

工具 capture 获得冻结的 `behavior` 身份，不可用时为 `null`；它仅用于工具可见性判断，
不是执行授权。原生与 JS 绑定共用该字段。

普通 Session 按 collaboration mode 选择 behavior 注册：Agent 使用配置名称，Plan 使用
`<name>:plan`（例如 `default:plan`），缺少注册时拒绝准入。经过授权的显式单 Turn behavior
直接选择对应注册；实际选定身份随执行冻结，并在 continuation 中恢复。

## 模型适配器

`ctx.modelAdapters.register(name, open)` 注册协议适配器。`open('request' | 'conversation')` 返回 `stream(request, context)` 和可选的 `confirm(history)`。Rust 使用 `maka_plugins::model::ProviderAdapter`，共享类型化事件、HTTP 与 WebSocket 契约。模型 override 的 `adapter` 指定贡献名称；默认名称为 `responses`、`chat-completions`、`anthropic-messages`。

Host 每逻辑步骤冻结注册，解析凭据，负责准入、取消、预算和规范日志结算。适配器会取得已解析秘密，不应记录请求或凭据；它负责协议编解码、带背压的事件输出和重试安全分类。HTTP body 随调用结束，socket 随适配器会话结束；下次调用通过新的 transport 操作已有 socket。路由身份变化使连接缓存失效。显式选择缺失或退休时失败，不暗中切换实现。
