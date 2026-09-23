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

# 启动正确性测试集

启动优化的验收包括数据规模、持久状态、故障时序和最终行为。已有 302 会话 / schema 19→20 假数据仍用于迁移、历史、图片及耗时比较；本测试集补充 steering、工具执行与恢复、交互等待、队列和后台任务。通过“界面可见、可以输入”不能替代这些行为断言。

## 运行

需要 Node 24 和已安装依赖。从要验证的 checkout 运行：

```sh
npm run test:startup-correctness -- --output artifacts/startup-correctness/my-run
```

默认先构建完整 Desktop 及依赖，再串行运行下列七组测试。若本轮源码已正确构建，可显式加 `--skip-build`。新建 fixture 使用独立临时目录、正式 root authority 和 SQLite 存储接口；Host 进程由现有 ExecutionFixture 启动和清理。不会打开用户工作区或执行真实外部工具。

真实 Electron 验收使用性能交接包中的本地保真 fixture 和驱动单独运行，不属于此 Node 入口。它记录错误 toast、renderer error 和 awaitReady 错误，并实际读取记忆和连接目录、加载历史公式所需的 KaTeX 字体。该业务正确性路径不测前台打字延迟；性能驱动的前台焦点检查保持不变。数据副本保留 rootId，因此不得与同一份数据的其他副本并行启动。Node 报告不宣称完成 Electron 验收。

入口：[`scripts/test-startup-correctness.mjs`](../scripts/test-startup-correctness.mjs)。输出 `report.json`、各组原始 TAP 日志和现有 tracked 改动的 `working-tree.patch`。HEAD 不能代表尚未提交的源码；新增测试/脚本也必须随修改保留。日志中的运行时长是测试成本，不能作为产品启动性能数据。

## 验收矩阵

| 组 | 状态和时序 | 必须验证的结果 |
|---|---|---|
| storage-authority | T1/T2 原子提交、事务回滚、兄弟连接写入、父工具依赖、恢复提交并发 | 失败无半条事实，重试不重复；无缓存时也不能漏验依赖 |
| tool-execution | 实际 ToolRuntime 调用、T1 失败、T2 失败、成功/失败结果、进度、嵌套工具、权限/问题等待 | T1 前不执行副作用；T2 前不发布结果；持久化失败不自动重复执行工具 |
| steering-and-recovery | steering 落库与 proof、恢复后的重放、权限恢复、各类工具账本 | steering 内容和身份正确；读取/重建/恢复对同一事实给出一致判断 |
| host-process-and-queue | 真实 Host 被 SIGKILL、已接收未创建 Run、队列 followup、消息重试、旧 Host epoch、交互等待、续跑 claim | ready 前完成必须的恢复；消息不丢失、不重复；交互旧句柄失效；不确定续跑不能误执行 |
| background-authorities | scheduled task、Goal、Graph、WorkHub 的恢复 | 各自持久权威驱动恢复，避免重复派发或错误认领 |
| desktop-readiness | Host 初连/重连、远程独立启动、会话切换、preload 门控、记忆/连接 IPC、队列 UI | 可以等待尚未完成的连接；失败和旧 scope 仍拒绝；读取与队列投影保持正确 |
| mixed-state-100k | 同一组正确性断言，加入 100,000 条无关历史正文事件 | 规模增加不能改变恢复决策；历史摘要不变；连续两次恢复不得追加重复事实 |

这些组复用现有语义测试，具体文件清单保存在入口脚本及每次报告中。没有复制恢复算法作为测试的“参考实现”，也没有另写一套宽松 reducer。

## 新增的混合状态场景

[`startup-state-matrix.test.ts`](../packages/runtime-host/src/__tests__/startup-state-matrix.test.ts) 包含两个集成旅程。常规测试使用 10 个历史会话、1,000 条正文事件；大规模组使用同一断言运行 300 个历史会话、100,000 条正文事件，另有 600 条 invocation opening/terminal 事实。背景历史通过已有正式批量导入接口准备；运行中 T1/T2 状态仍通过各自的正式提交接口构造。

第一个旅程在同一个 root 中准备六个未结束会话，并同时启动真实 Host：

| 工具状态 | ready 后的验收 |
|---|---|
| replay_safe，T1 已提交，T2 缺失 | 原 Run 以 app_restarted 结束；不能凭空生成成功结果 |
| reconcile，T1 已提交，T2 缺失 | 保留未观察到结果的事实，不能伪造外部状态已完成 |
| never_auto_retry，副作用可能发生 | 不能通过启动恢复盲目补执行或伪造结果 |
| outcome_unknown，Client Capability 已派发 | 持久化一个 outcome_unknown 错误，明确 retrySafe=false |
| T2 成功已提交，Run 尚未结束 | 保留原结果身份和内容，终结 Run，不能重写结果 |
| T2 失败已提交，Run 尚未结束 | 保留错误标记，不能恢复为成功 |

再启动一次，逐条比较恢复后的 RuntimeEvents；六个会话都不能新增重复事实。两次恢复均核验所有背景历史的条数和 SHA-256。

第二个旅程通过真实 UDS 提交运行中请求和带引用的 steering，等待真实持久 echo 后 SIGKILL Host。继任 Host 必须保留相同 Run 身份并终结中断；steering/followup 队列为空；带旧 epoch 的重试不得重新派发；steering 内容只出现一次。再重启一次，逐条核对全部事件不变。

工具状态通过正式 T1/T2 API 生成；这个旅程验证启动恢复决策，不宣称执行了真实外部副作用。实际工具调用与持久化失败之间的顺序由 tool-execution 组的真实 ToolRuntime/SQLite 断言覆盖。这样可以明确区分“恢复边界状态”和“执行边界时序”的证据。

## 防止测试假绿与简化

新增旅程应至少通过一次行为 mutation 检查。例如临时禁用已派发 Client Capability 的启动恢复结算，混合状态测试必须因缺少 outcome_unknown 结果而失败。恢复产品代码后再运行正式测试集；变异后的耗时和结果不能混入性能报告。

使用已有 Host fixture、正式存储、既有测试断言和直接的文件清单。不新增通用场景 DSL、第二套校验器或缓存状态。每次重跑重新构造状态，原始 302 会话性能库保持原样。

首轮 Electron 检查实际捕获过 KaTeX 小字体被 Vite 内嵌成 data URL、随后被 CSP 拦截的错误。修复采用构建时保留字体文件，沿用原 CSP；原失败日志保留。状态/恢复测试通过和完整桌面启动通过必须分别记录，不能用前者覆盖后者。

## 明确的边界

- FakeBackend 提供确定性的流式输出与 steering 检查点，不证明真实提供方网络、限流或 SDK 行为。
- 100k 混合状态库以不可变正文为背景负载，不替代带大工具结果、图片和归档的 302 会话保真库；两者互补。
- 原 302 会话合成数据的 44 个子会话缺少 subagentRuntime，不能用它宣称技能/子代理可执行性通过。子代理、Graph 和 WorkHub 依靠相应的合法 fixture 测试。
- 本轮本机结果不代表 Windows/Linux、真实系统权限弹窗、真实外部副作用或断电后的磁盘持久性。
- Host ready、界面可见、输入回显、历史可见和业务读取成功是不同指标。正确性测试失败时，性能数字只能作为诊断，不能据此通过上线验收。
