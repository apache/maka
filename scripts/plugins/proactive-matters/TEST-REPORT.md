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

# 持续跟进插件验证记录

日期：2026-09-22。Maka 基线：main `c6e3eb0cd0535736f328252ab137f9cc06496da3`。使用独立 worktree 读取主干源码，主干 `git status --short` 为空。实现、构建产物、测试数据均位于插件目录。

## 自动化验证

26 项通过：20 项持久化/状态事务测试，4 项真实 PluginPlatform 集成测试，1 项真实 Client Runtime DOM 测试，1 项发布包安装测试。TypeScript 检查通过。

覆盖绝对时间唤醒、同一 session 续跑、旧轮次/旧版本拒写、未提交退出时暂停、完成后清空唤醒、重启恢复、不可变历史、用户修改要求、排队唤醒的领取竞态、面板暂停与 Remote generation 隔离，以及 `.maka-extension` 直接安装后注册 Host/Client 并启动/取消任务。

安装测试最初有一个测试代码错误：把 workspace 返回对象当成事项对象取 id，导致取消 RPC 参数缺失。修正为读取事项列表中的 id 后通过；包本身的导入和工具注册已经成功。

## 真实模型场景

模型：`deepseek-flash`。调用 main 的 AiSdkBackend；PluginPlatform、工具服务、提示词服务和包加载器使用 main 实现。用于接续会话的 Host Agent driver 是测试适配器，业务 API 是本地 HTTP 模拟服务，不访问真实网盘/日历/项目账户。

任务：跟进设计交付，在最新稿件审核满足要求后建会并更新项目任务；六分钟内给出结果；不发送邀请。过程注入新增无障碍审核要求、三个稿件版本、旧版本审核通过、最新版审核拒绝/通过、日历时段变化及并发冲突。

| 相对开始时间 | 行为与结果 |
| --- | --- |
| 0–29 秒 | 第一轮检查 v1，审核未通过；写状态、总结并登记下次唤醒。 |
| 60–82 秒 | 用户补充“最新版必须通过无障碍审核”；第二轮接收要求并继续等待。 |
| 185–201 秒 | 第三轮看到 v1 已通过、v2 被拒、v3 审核待定；没有用旧版提前建会。 |
| 220 秒 | 模拟外部服务中 v3 的无障碍审核通过；插件不监听文件变化，等待下一次时间唤醒。 |
| 304 秒 | 第四轮由定时器唤醒，重新确认最新版与审核结果。 |
| 312–316 秒 | 首次建会遇到时段被抢占；重查后改到 16:30。第二次建会已提交但响应丢失；按请求标识查询确认，未重复创建。 |
| 317–320 秒 | 项目任务更新遇到版本冲突；重读后成功更新，并保留项目经理新增备注。 |
| 330–332 秒 | 提交完成状态，结束本轮。 |
| 338 秒 | 完成后再加入 v4 并观察六秒；无新增模型轮次或业务调用，唤醒列表为空。 |

结果：一场会议、一次有效项目任务更新、均引用 design-v3；无邀请发送；三个故障分支实际触发并恢复；任务在六分钟以内完成。

共 4 轮、35 次模型请求、50 次工具调用。后三轮起始请求携带的历史工具结果分别为 11、23、32 条，验证没有在唤醒时清空对话。累计输入 731,443 tokens、输出 18,130 tokens（输入包含每步重复携带的历史，不等于唯一上下文大小）。长对话加完整历史会增加成本。

仍存在可优化行为：第二轮模型把已入库的用户补充又调用 MatterMessage 登记一次；第四轮成功后额外查询了一次 CalendarEvents。前者已在最终协议中明确禁止重复登记运行时唤醒/inbox/request 中的输入，但这条提示词修改没有再跑一遍付费模型场景，不能声称实测消除。

原始证据：`.artifacts/live/handoff-9p75CT/report.json` 和同目录 `trace.jsonl`。密钥仅通过进程环境传入，报告不包含密钥。

## 覆盖边界

- 真实模型运行期间另补了队列领取竞态修复；最终代码由专门的排队回归测试覆盖。本次模型场景使用立即启动的宿主返回路径。
- Client 使用真实 Slots/Remote 的 DOM 测试，尚未做发布版 Electron 的人工点击全流程。
- 主干插件 API 不提供全局业务工具拦截；Matter 状态写入有硬校验，settle 后禁止继续调用其他业务工具属于 agent 协议。
- 完成后静默只观察六秒；长期后台运行、系统休眠和生产服务故障仍需后续运行验证。
- 插件只负责持续跟进与状态。实际连接外部应用依赖原 session 可用的工具及权限。

## 2026-09-22：只读浮窗改版

面板改为缩略任务列表，点击后显示当前进展、最近一轮已完成工作及后续安排。取消面板中的新增、暂停、继续、聊天、更多和编辑操作；内部状态文件不再显示。展示摘要来自持久化的 update / summary / next，时间来自已登记的 wake，不从状态文件截取。

更新后的 26 项测试全部通过，类型检查通过。Client 集成测试现在覆盖展开、返回、收起、只读性与真实 Remote Stream 刷新；先前记录的面板暂停按钮测试已被替换。后台暂停接口及其测试保留。

使用实际组件在 Chrome 渲染列表和详情，并检查 1160px、390px 窗口。截图使用明确标记的示例数据与聊天背景，不是实际 Maka 桌面截图；新简短摘要协议没有重新调用付费模型验证。入口后续通过 `sidebar.navigation` 宿主插槽放在新任务与 WorkHub 之间，宿主布局只提供通用扩展槽，任务入口与浮窗仍由插件渲染。

截图：`.artifacts/preview/task-list.png`、`task-detail.png`。可用 `node scripts/preview.mjs` 重新生成独立组件预览 HTML。

## 仓库内集成验证

插件迁入 `scripts/plugins/proactive-matters/`，PR 基线更新为 main `5263fb78a`。测试用代码默认从所在仓库解析，无需依赖原独立目录。重新运行构建、当前 main PluginPlatform / Client Runtime 集成测试、发布包导入及类型检查：26 项全部通过。真实 Flash 场景为前述历史验证，本次迁移没有重复调用付费模型。变更只在插件目录，不增加根 workspace，也不改 Maka 核心实现。

## PR review corrections

- Mutating tools, including activation-binding/observation `MatterRead`, are classified as `file_write`. A regression test calls the actual main `selectCollaborationTools`: ordinary Plan mode retains only `MatterReadFile`, while agent mode retains all plugin tools.
- Enrollment now requires an absolute cwd and saves the matter, session binding, initial event and history in one transaction. An injected SQLite failure immediately after binding insertion rolls back all database records; restarting and retrying succeeds.
- Removed Client mutation RPCs and the unused writable bridge contract. A test calls the actual generation-fenced Host bridge with valid descriptors and payloads: all three removed methods return `not_found`, and state is unchanged. UI stream tests now change state through the session agent tool.
- Updated the opt-in live scenario to deliver its amendment as an ordinary human conversation turn; no paid model run was performed for these fixes.

The updated suite has 29 passing tests; build, extension import and typecheck pass. Historical 26-test and Flash results above describe the earlier implementation, not proof of these fixes.

## 2026-09-24：独立长任务对话框

浮窗显式固定在右上角。面板加入输入框：首条消息使用 Maka 现有桌面会话接口创建独立 session，先经插件 Remote 登记该 session，再发送用户原文；后续消息留在同一 session。详情保留进展摘要，并显示最近的用户与助手对话。

Host 不再向普通 session 注入持续跟进启动提示；`MatterStart` 校验插件登记的 session，普通聊天无法登记。现有 29 项测试、扩展包构建与类型检查通过；Client 集成测试覆盖对话框的创建/发送、右上角定位和普通 session 的拒绝。会话接口在 DOM 测试中是受控替身，尚未做发布版 Electron 人工点击或付费模型运行。

## 2026-09-24：插件化的 turn 结束检查

Maka runtime 增加通用 `ctx.turns.beforeFinish` 插件接口。在模型自然结束、仍可继续同一个 turn 时调用；插件可放行，或返回一条仅用于下一步的反馈。持续跟进插件用它要求当前 activation 在退出前调用 `MatterSettle`，业务规则仍留在插件内。`wait` 必须同时带具体等待条件和未来检查时间；去掉连续 `continue` 五轮上限，保留事项总轮次和单轮超时。

插件构建、发布包导入、类型检查和 30 项测试通过；AiSdkBackend 的 242 项测试通过，其中新增用例确认结束检查拒绝后在同一 turn 再次调用模型，最终只产生一次完成事件。Maka runtime 与 runtime-host 类型检查通过。此前的付费 Flash 场景没有为本次改动重跑；宿主模型步数或执行时限耗尽时，结束检查不会强行超出上限，未 settle 的 activation 会暂停。

随后新增插件 + Maka 模型循环端到端用例：由真实 PluginPlatform 安装插件并授权长任务 session，受控模型先尝试自然结束，结束钩子拒绝后在同一 turn 调用真实 `MatterSettle`，第三次模型响应才结束；最终事项为 waiting，激活正常收尾，完成事件恰好一次。完整插件验证共 31 项全部通过。

另用 Flash 启动原跨应用模拟场景。首次运行暴露场景漏掉浮窗 session 授权的问题，已补齐后重跑；模型成功注册事项并提交 wait，但它选择的复查时刻晚于六分钟测试窗口，因此我停止了场景，未计为完整 Flash 成功。该轮还观察到模型将互斥的 `MatterRead` 与 `MatterStart` 放在同一批工具调用中，runtime拒绝后模型重试；这说明真实模型行为仍需继续验证，不能用受控模型测试替代。

## 2026-09-29：Session ID 对接与独立提交审核

Client 将桌面 `[hostId, runtimeSessionId]` 转为 runtime ID 用于授权和事项匹配；重新打开已有事项时从桌面 session catalog 找回当前 Host 的完整 ID，聊天读取与发送仍使用完整桌面 ID。DOM 集成测试包含两个 Host 下相同 runtime ID，检查不会串到另一 Host。

MatterSettle 通过现有 `ctx.llm.generate` 调用独立审核，包含原始目标、所有用户补充、旧状态、新草稿、待处理事件以及当前会话 transcript / inbox。SQLite 保存提交指纹、审核开始时间、依据快照和模型结果；拒绝保持 active，反馈回普通 loop，无拒绝次数上限。Host 抛出的 `MATTER_REVIEW_INVALIDATED` 或审核前后执行记录/状态变化要求刷新重试，不写成拒绝；模型返回的 JSON 使用严格 verdict schema，不能触发 Host 失效通道。

定时合法性以该操作、该内容的审核开始时间判断。审核中到期的时间可提交，但 activation 结束前扫描不入队；结束后的扫描只产生一个定时事件。审核前后及最终 SQLite 提交事务内校验状态、事件、草稿和历史版本；重复操作不能换内容或借用其他提交时间。

新增覆盖：审核跨 store 重启、定时过期与去重、操作指纹绑定、四次拒绝后通过、持久拒绝幂等重放、输入/草稿/checkpoint/暂停竞态、执行记录变化、Host 失效与模型伪造失效字段。真实 Maka AiSdkBackend loop 使用受控模型连续四次被审核打回，在同一 turn 中继续，批准后仅产生一次完成事件。此次未调用付费模型，未做新的 Electron 人工操作；本次测试证明协议与集成行为，不衡量审核模型判断质量。

最终 `npm run verify` 通过：43 项测试，含真实插件安装包导入、Client DOM 集成、SQLite 竞态/重启、Maka loop 端到端测试；插件构建与类型检查通过。

### 2026-09-29 — Review journal migration and bounded model review

Added regression coverage for migration of an incompatible eight-column journal, repeated reopening without losing legacy records, refusal to reuse a legacy approval even with the same operation ID, bounded reviewer input, changes in omitted execution history invalidating approval, oversized essential input, and a timed-out provider that ignores cancellation followed by successful retry without pausing.

The live reviewer adapter has a controlled model transport test for prompt/output-budget forwarding and preservation of a rejection. The live scenario now calls the real reviewer and records its output and usage instead of accepting the fixture's default approval. No real-provider run was performed for this revision: `MAKA_SCENARIO_API_KEY` is not available in the current process environment. Controlled-model tests are not evidence of real review quality.

Validation: `npm run verify` passed (build, generated runtime adapters, extension packing, tests, TypeScript). After the final legacy-operation collision regression, all 49 tests passed; Biome and `git diff --check` passed.
