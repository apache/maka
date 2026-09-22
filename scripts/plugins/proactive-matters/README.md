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

# Maka 持续跟进插件

独立 Host + Client 插件，位于 `scripts/plugins/proactive-matters/`，使用当前仓库的插件接口。不修改 Maka 源码，不依赖旧分支内置的 MatterService、Goal 或 Automation。

在一个对话里委托持续跟进；插件保持同一个 session，登记绝对时间唤醒，让普通 agent loop 每轮基于当前情况决定行动。状态与计划是先前判断的参考，不是必须照着执行的流程。

## 安装与使用

发布文件：`release/proactive-matters.maka-extension`。使用目标 Maka 的现有插件安装入口，或：

```sh
maka runtime-host plugin install /absolute/path/proactive-matters.maka-extension --root /absolute/path/maka-workspace
```

安装会通过 `maka.composition.json` 注册 `profile` Host 和 `desktop-ui` Client。无需手工编辑 Maka 的配置或 IPC。

在对话中说「帮我持续跟进……」，模型调用 `MatterStart`。侧边栏「长任务」打开右侧轻量浮卡：列表仅展示名称与下次检查时间，点击任务查看当前进展、已经做了什么及接下来的安排，可返回列表。界面只读，没有新增、聊天、暂停或更多操作按钮，不展示内部状态文件。每个对话支持一个事项，结束后新事项请使用新对话。

后续用户修改要求在对话中由 `MatterMessage` 记录。普通聊天消息不会被插件自动当成状态事件；必须经过该工具登记。时间唤醒不会清空上下文，也不会附带整份业务状态，只传唤醒原因、时间和文件入口。

## 实现

- `src/host.ts`：`host.apply(ctx, config)`，注册工具、基础协议、动态时钟与 Client RPC/Stream。
- `src/controller.ts`：调度、当前 session 续跑、暂停与重启恢复。工具启动时绑定当前 session，不创建第二套模型执行器。
- `src/store.ts` / `src/files.ts`：独立 SQLite 与不可变状态版本。状态、事件确认、轮次总结、唤醒和进展在事务内一起提交。
- `src/client.js`：原生 Client Slots + generation-fenced Remote，使用宿主 React，不增加专用 IPC。

工作文件：`request.md`（原始及后续要求）、`state.md`（最新判断和小计划）、`inbox.json`（待处理输入）、`changes.jsonl`（带时间的追加历史）、`draft.md`（本轮草稿）。历史操作与每轮 summary/reason/next 都追加保存。

运行时服务使用 `ctx.agents.resume/followup/whenIdle/cancel`。后台适配器通过公开的 `withInvocation` 方法建立插件自己的 Host 调用上下文，但只允许自身数据库中由 `MatterStart` 登记的 session/cwd；UI 不能传入任意 session 或目录让它执行。模型权限仍由原 session 和 Maka runtime 决定，插件不改权限模式。

首次激活把独立数据目录写入 `ctx.storage`。默认位于 `~/.maka/plugin-data/dev.maka.proactive-matters/<uuid>`；也可在第一次激活的 Host entry config 设置绝对 `dataDirectory`。之后以已保存位置为准，避免热配置悄悄切换存储。

调度器在插件注册事务提交后启动，由 Fiber 清理；SQLite 30 秒可续租租约避免新旧实例同时派发。等待中的任务重启后继续；正在执行且结果不确定的轮次暂停，不盲目重放外部副作用。Host 原生队列返回 `followup` 时，等待实际轮次通过 `MatterRead(activationId)` 领取，避免把暂时空闲误当成执行完毕。

## 验证

```sh
cd scripts/plugins/proactive-matters
npm ci
npm run build
# 只读取 Maka 最新 main 源码，将测试用编译结果写在插件 .artifacts 内
npm run prepare:test
npm run pack:extension
npm test
npm run typecheck
```

构建测试用宿主代码需要 Maka 的依赖已安装；也可用 `MAKA_NODE_MODULES=/absolute/path/node_modules` 指向已有依赖目录。插件发布包自身不需要这些测试依赖。

测试使用真实 main 的 Context/Fiber、PluginPlatform、包加载器、Agent/Tool/Prompt 服务、Client Runtime、Slots、Remote；自动化业务执行测试的 Agent driver 是受控替身。另有 opt-in 真实 Flash 跨应用交付场景 `scripts/live.ts`，使用 main 的真实 AiSdkBackend，业务 API 为本地模拟。密钥只从 `MAKA_SCENARIO_API_KEY` 读取，不写入插件或报告。真实场景需要先生成 main 对应的模型元数据到 `.artifacts` 并构建 `scripts/extra-api.mjs live`。

当前 main 提供 `sidebar.footer` 与 `shell.overlay` 插件槽，因此入口仍位于侧边栏底部；精确插入 Workhub 上方需要宿主提供相应导航槽，本插件没有修改 Maka 或使用 DOM 搬动入口。

## 当前边界

- Host 进程必须活着；插件不是操作系统级常驻服务。睡眠期间错过的检查会在 Host 恢复后处理。
- 最多同时执行两件事项，每轮默认 10 分钟，事项默认 100 轮；连续立即继续最多 5 轮。
- 代码保证 Matter 工具的版本、轮次、下一次唤醒、完成后清空调度等约束。当前 main 的插件 Tool 注册接口不能统一拦截所有宿主业务工具，所以成功 settle 后「不再调用其他业务工具」依靠 agent 协议，不能声称具有旧内置版本的全工具强制拦截。暂停/取消会请求宿主停止 session，但已提交外部服务的操作不能撤销。
- 完成由模型判断；仅支持时间唤醒和用户输入。状态为 agent 维护的记事本，不强制业务 schema。
- 进展保存在插件面板，也可由模型在原对话汇报；未增加系统通知服务。
- UI 验证通过真实 Client Runtime + DOM 测试，不等同于发布版 Electron 全流程验证；模型测试也不连接真实网盘或日历账户。

已安装仓库依赖时，可以在插件目录运行 `npm run verify` 完成上述全部检查。这个目录不在 npm workspace 列表中，不改变主项目依赖或默认发布产物。

真实模型场景复现（会调用模型服务）：

```sh
# 从插件目录执行；输出只落到插件目录
export MAKA_SOURCE="$(cd ../../.. && pwd)"
node "$MAKA_SOURCE/scripts/sync-model-metadata.mjs" --output "$PWD/.artifacts/model-metadata.generated.ts" --pricing-output "$PWD/.artifacts/model-pricing.generated.ts"
node scripts/extra-api.mjs live
# 通过进程环境安全提供 MAKA_SCENARIO_API_KEY
node --import tsx scripts/live.ts
```

本次结果及覆盖边界见 `TEST-REPORT.md`。
