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

# Side Conversation 简化消融实验（2026-09-11）

这是 PR #4901 的一次本地实验快照，不是新的架构契约。

## 结论

原实现不是这次实验找到的最简单写法。保留必要的恢复机制，合并五处重复逻辑后，生产代码减少 **40 行非空行**，原有 209 项相关测试全部通过；加强两类边界输入后，实际实现的 210 项相关测试全部通过。

减少行数不是唯一选择标准：一个更短、也通过原测试的逐条恢复方案被拒绝，因为它会对每条恢复身份重复扫描历史并调度状态更新。本次没有证明全局最小实现，也没有测量实际交互性能。

## 方法与复现

- 对照提交：`a450cc7e7675a4fbe2f7e141d2b5ddcc4668c7e3`。
- 环境：Node `v24.14.0`，仓库现有 npm / esbuild，不添加依赖。
- 每次只对同一个对照提交做一项生产源码变换；通过 Node 加载钩子在内存中转译，不覆盖源码或构建产物。最终再测试五项简化组合。
- 基础消融固定对照提交中的 hook 测试，其余测试使用已构建的同版本产物。覆盖 hook、临时消息投影、服务适配、transcript range、执行 IPC、observer、队列状态和共享 Composer，共 209 项。
- 另用两类输入探针检查原测试遗漏：Host 编辑排队文本；迟到的 started 回执读取历史失败。探针与基础结果分别记录，不把删除代码后仍然通过测试当作等价证明。
- 实验脚本和一次性 npm 命令归档在本地分支 `experiment/side-chat-ablation-20260911`，未推送。下述验证记录对应 9 月 11 日的实验快照；生产简化及回归测试随本报告单独提交，不包含一次性实验脚本。

在实验分支、依赖和 workspace 构建产物准备好后运行：

```sh
npm run prototype:side-chat-ablation
npm run prototype:side-chat-ablation -- baseline combined-simplification
npm run prototype:side-chat-ablation -- --interactive
```

脚本路径：`apps/desktop/src/renderer/features/workbar/tools/side-chat/side-chat-ablation.prototype.mjs`。每项打印 JSON：变体、问题、非空行变化、退出码、通过数、失败数和失败测试。变体失败属于实验数据，须查看逐项退出码，不能把外层脚本正常退出理解为所有变体通过。

实验分支故意将 Node-only 一次性脚本放在被研究模块旁边；不要将这个脚本或 npm 命令合入生产，renderer 架构检查会拒绝它的 Node 环境依赖。

## 单项消融结果

下表均使用同一组 209 项原有测试；每行独立变更，不是逐步累积删除。

| 变体 ID | 变更 | 通过 / 失败 | 决策与证据 |
| --- | --- | --- | --- |
| `baseline` | 原实现 | 209 / 0 | 对照 |
| `no-execution-recovery` | 删除执行身份恢复 | 207 / 2 | 保留：取消消息不能清理，观察中断期间的中间后续 Turn 不能恢复 |
| `no-targeted-recovery` | 删除窗口外 Turn 定向读取 | 208 / 1 | 保留：A→B→C 中断后，只有最新 C 的窗口不足以恢复 B |
| `arm-started-receipt` | started 回执直接激活 Turn | 205 / 4 | 保留原判断：迟到回执可能重新激活已完成 Turn，或影响更新的活动 Turn |
| `no-retained-terminal-proof` | 仅信当前窗口，不查本地保留的终态 | 208 / 1 | 保留：B 离开窗口不代表它没有完成 |
| `no-durable-retirement` | 不从 pending Map 清理已有持久化消息 | 205 / 4 | 保留：持久化身份必须退出本地待处理投影 |
| `unbatched-executions` | 所有身份一次发给 Host | 208 / 1 | 保留：65 个身份必须拆成 64+1；Desktop 上限仍为 4096 |
| `no-terminal-admission-replay` | 终态恢复不重放 admission | 208 / 1 | 保留：重连需要先恢复消息与 Turn 的归属 |
| `no-queue-shadow` | 删除队列到临时消息的投影 | 209 / 0 | **拒绝**：新增 Host 编辑探针失败，原测试覆盖不足 |
| `no-eager-transcript-read` | 由 observation-ready 统一触发首次读取 | 209 / 0 | 采用：减少 9 行，移除重复初始读取 |
| `no-dead-admission-branch` | 删除早返回后的不可达 admission 分支 | 209 / 0 | 采用：减少 6 行 |
| `one-pending-reconciliation` | 集中 own-Turn 过滤和 pending 清理 | 209 / 0 | 采用：减少 10 行，调用者无需重复过滤 |
| `single-receipt-read-exit` | 回执读取成功/失败共享后续判断 | 209 / 0 | 采用：减少 10 行，且修复读失败绕过保留终态的问题 |
| `shared-query-validation` | 两个 IPC 查询复用身份参数校验 | 209 / 0 | 采用：减少 5 行，保留独立查询和传输分批 |
| `shared-recovery-updates` | 恢复循环逐条复用归属/删除 helper | 209 / 0 | **拒绝**：虽减少 25 行，但重复扫描历史、逐条调度状态更新；未做性能基准测试 |
| `combined-simplification` | 合并上述五项采用的变更 | 209 / 0 | 采用：合计减少 40 行，保留批量恢复更新 |

## 覆盖缺口探针

| 探针 | 原实现 | 对应变体 | 发现 |
| --- | --- | --- | --- |
| Host 将排队消息从 `queued follow-up` 改成 `Host-edited follow-up` | 209 / 0 | 删除队列投影：208 / 1 | 本地临时消息仍显示旧文本；不能直接删除队列投影 |
| 已保留 B 终态、B 离开窗口，迟到 started(B) 的定向读取拒绝 | 208 / 1 | 共享读取出口：209 / 0 | 原 catch 直接重新激活 B；简化后读失败只表示没有新增证据，仍检查保留的终态 |

这两类输入已进入正式 hook 回归测试：加强现有队列测试的 Host 编辑输入，将已有迟到回执测试参数化为读取成功与失败两种情况。实际测试总数由 209 增为 210，没有为实验脚本新增测试框架。

## 生产候选

- `use-quote-companion.ts`：非空行 1677 → 1642；统一 pending 清理、读取出口，删除重复读取和不可达分支。保留所有权恢复、定向历史读取、终态证据、队列投影及批量更新。
- `runtime-host-session-execution-ipc-main.ts`：非空行 1038 → 1033；共享 `requiredMessageIds` 校验，不改变身份规则、重复检查、4096 上限或 64 条传输分批。
- `quote-companion-retry.test.ts`：覆盖上述 Host 编辑和读取失败场景。

## 验证与限制

- 实际候选重新构建后：210 / 210 项相关测试通过。
- Desktop main 构建、renderer 构建、Desktop 完整 typecheck、根 lint / format 检查、Desktop knip、`git diff --check` 通过。
- Renderer 构建仍提示部分 chunk 超过 500 kB；入口和第三方声明校验通过。该提示不是这次消融的性能测量。
- Renderer 架构 checker 的 103 项 fixture 测试通过；移出一次性脚本后，当前树与对照提交的架构检查通过。
- 没有执行全仓测试、真实 Electron 断连/多后续消息手工验收或穷举异步时序；不能据此声称所有竞态已消除或实现已达到理论最简。

## 9 月 12 日主线合并复核

- 同步主线 `12d3fb9332`（含 Renderer transcript window 重构），保留上述五项简化。旧的 Turn-ID history 导航已被主线删除，因此定向恢复改为通过现有 Host `listTurns` 取得 `firstSequence`，再使用新的 `loadAround` / `loadAfter` 读取到目标终态；仍受 settlement 时限约束，不将缺少位置或回复视为完成。
- 将现有 settlement 实现迁入 `platform/desktop/session-message-settlement.ts`，更新调用方并删除旧实现与冗余内部转发。没有新增 Host 协议，也没有恢复主线删除的导航接口；架构清单同步移除了旧的 platform-to-legacy 依赖。
- 补充跨页终态、缺少索引位置用例。清理旧 `dist` 并重新构建后，Desktop 全量 2527 / 2527、共享 UI 419 / 419 测试通过；全仓 build / typecheck、lint / format、Desktop 与 UI knip、103 项架构 fixture 和相对主线的架构检查通过。此次相关回归为 209 项，计数变化包含主线替换旧 transcript 测试。
- 逐项核对 PR #4901 的 3 条讨论评论、18 次 review 提交和 6 个行内线程。6 个线程均已关闭，其中正常 handoff 的 P1 已由 reviewer 撤回；迟到回执、终态/多后继恢复、pending 真正退休、64-ID 分批、等待 Host 准入均有实现和回归覆盖。review 正文提出的窗口外回复恢复也已按主线新接口重新验证。
- 仍不声称完成真实 Desktop 的 Enter / Shift+Enter、多条追问、编辑/重排/撤回及断连重连手工验收；独立人工批准也尚未获得。线程关闭不等同于界面验收或批准合并。

Generated-by: Codex
