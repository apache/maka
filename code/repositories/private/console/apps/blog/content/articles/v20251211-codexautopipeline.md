---
slug: v20251211-codexautopipeline
title: "[抢先看]我把Codex变成了一个自动执行的工程流水线"
series: "AI 工程实践"
source: ghost-lab
date: 2025-12-11
excerpt: "1. 把任务拆成 Phase，并用一个变量（如 PHASE_TARGET）切换阶段，减少人为漂移。"
---

# [抢先看]我把Codex变成了一个自动执行的工程流水线

- **视频 ID**：`V20251211-CodexAutoPipeline`
- **日期**：2025-12-11

> **一句话**：这不是在“问 AI”，而是在“调度 AI 跑流水线”：主控只负责计划/调度/验收，执行交给 subagent。

## 精华总结
- TODO 不是计划，而是可验收的半规范：每条任务都要写验证方式；Deliverables 必须可运行、可检查。
- 实现任务与测试任务成对出现；Phase Done 不能靠打勾，必须有 E2E Cone 作为硬门槛。
- 严格串行是底层纪律：当前 TODO 没验收通过，不进入下一个；并行只会把错误放大成系统性崩溃。
- 日志覆盖率/可观测性是维护门槛：没有日志，指望 agent 自己跑自己修是幻想。

## 行动清单
1. 把任务拆成 Phase，并用一个变量（如 PHASE_TARGET）切换阶段，减少人为漂移。
1. 给每个 TODO 配验收：build/test/E2E 证据路径写清楚。
1. 把 thread_id / run_id 落盘（可复盘可恢复），并建立最小 E2E Cone。

## Highlights（原文摘录）
- “这套执行系统只依赖一个变量：PHASE_TARGET。我只改这个数字，流水线自动切到对应 Phase。”
- “这不是在问 AI，这是在调度 AI 跑流水线：主控只做计划/调度/验收，不写业务代码。”
- “TODO 不是‘计划’，而是‘可验收的半规范’：每条任务必须写验证方式。”
- “Phase 结构固定：Goals → Deliverables → TODO；Deliverables 必须是看得见、跑得起来的产物。”
- “实现任务与测试任务必须成对出现：前半做功能/重构，后半做自动化测试/E2E/CI。”
- “日志覆盖率 100% 是可维护性的硬门槛：没有日志，指望 agent 自己跑自己修复是做梦。”
- “subagent_shim.py 把 UI 概念变成系统调用：create / resume / thread 恢复 / 产物回收。”
- “thread_id 必须落盘：写入 tasks/phase_${PHASE_TARGET}，否则无法复盘、恢复、追责。”
- “严格串行是底层纪律：当前 TODO 没验收通过，绝不进入下一个；并行只会把错误放大成系统性崩溃。”
- “验收不通过不是‘骂两句’，而是结构化 JSON 返工指令 + resume，直到满足 acceptance_criteria。”
- “当前系统能跑但不可靠：Phase Done 标准太弱，TODO 打勾 ≠ 行为稳定。”
- “v0.2 的唯一硬门槛：Phase E2E Cone（少数端到端命令）成为 Phase Done 的判定标准，并接入 CI/Orchestrator gate。”
- “下一步不是更复杂 prompt，而是强契约：schema / snapshot / invariants + logging 事件检查。”

## Insights（原文摘录）
1. 本期内容定位：L3（实践与实例）→ L4（系统化工程）过渡
   - 你不在讲“提示词技巧”，你在讲“调度器 + 验收体系”的工程化范式。

2. 核心洞察：AI Coding 的真实瓶颈不是模型，而是“可复现约束”
   - Spec/TODO 解决“做什么”
   - Orchestrator + 串行 + 验收/返工闭环 解决“怎么做对”
   - Log/Trace/Thread 解决“怎么可追责、可恢复、可演化”

3. 你构建的其实是一个最小可运行的 AI 工厂抽象（MVP）
   - 控制变量：PHASE_TARGET（单点控制）
   - 轨道：Phase FIFO queue（固定顺序，防发散）
   - 执行单元：Subagent（一任务一工人）
   - 质量门：Acceptance Criteria + 真实执行/Review + 返工 JSON
   - 追踪：thread_id 落盘（可恢复、可复盘、可审计）

4. 为什么你强制“主控不写代码”是对的
   - 一旦主控也写代码，就会出现职责污染：调度依据被破坏、验收标准被稀释
   - 这会把系统从“流水线”退化回“人肉协作式聊天写代码”

5. 现阶段最大技术债：Phase Done 判定的“行为层缺失”
   - TODO 完成/单测通过只能证明局部正确
   - 但 orchestrator 需要的是“系统行为稳定”的硬信号
   - 这就是为什么 Phase E2E Cone 必须成为唯一门槛

6. v0.2 的升级路线是正确方向：把“工程真相”编码进系统
   - 用 Cone 把“用户视角行为”固化成可运行命令
   - 用 CI/Gate 把“完成定义”变成不可绕过的约束
   - 这一步做完，系统才真正具备“自动化可信度”

7. 你在无意中踩中了 long-running agent 的核心：可恢复状态比聪明更重要
   - thread_id + tasks/phase 目录，本质上就是最小 state store
   - 未来要扩大到多 phase 自动衔接，关键不是更多上下文，而是更强的 state machine

8. 下一步建议（不绕弯，按收益排序）
   - P0：为每个 Phase 定义并固化 1–3 条 E2E Cone（脚本 + 退出码 + 期望输出）
   - P1：TODO 同时输出 Markdown（给人 review）+ JSON（给 agent 执行/对齐）
   - P2：验收结果写入统一的 phase_report（包含 Cone 结果、关键日志事件、失败截图/片段）
   - P3：引入 invariants（跨 phase 不变量）与 golden snapshot，防止“越修越歪”

9. 这期对会员的真正价值，不是文件本身，而是一个结论：
   - Prompt 只是入口
   - 生产力来自：调度纪律（串行）+ 质量门（验收）+ 可恢复性（trace）
   - 谁能把这三件事做硬，谁就能把 AI 变成稳定劳动力，而不是随机输出器
