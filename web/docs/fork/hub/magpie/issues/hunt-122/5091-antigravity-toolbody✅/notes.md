# #5091 车道 A 分析笔记（fix/5091-antigravity-toolbody）

## 假设清单（Phase 3，动手前列出）

| # | 假设 | 裁定 | 依据 |
| --- | --- | --- | --- |
| H1 | 解码器把某形状的 functionCall part 误当 text（thoughtSignature 缺失/字段异常 fallback） | **否决** | 报告者诊断构建在解码器**之前**复制响应体：上游 119 个 part 全是 `parts[].text`，0 个 functionCall；上下游可见文本字节级一致（SHA-256 相同）。解码器无件可误判 |
| H2 | 上游模型真把工具调用写进正文（形状在 magpie 现有识别之外）→ 本轮流式无更好解码层可修，属模型行为 | **确认** | 客户端 0 tool_use + 正文含参数 JSON 原文 ⇒ 解码器未转换（现有 `call:default_api:` 转换若命中会产出真 tool_use） |
| H3 | 长会话恶性循环根因 = 伪调用记录留在发往上游的助手历史，模型逐轮模仿 | **确认** | 报告者对照实验：清理历史中 39 条"伪完成工具包装＋重复答案"后，同账号同模型同问题恢复正常正文；短上下文同路由返回正常 tool_use |

## 判定：Magpie 侧可修层

- **接收侧（解码器）无可修**：上游没有发 functionCall，没有任何"认出/转换"可做；把正文模仿调用提升为可执行工具被报告者明令禁止（副作用工具风险）。
- **根因修复 = 请求侧历史清理**（报告者建议 #2，其自身对照实验背书）：Antigravity 路由构建请求时，把助手轮里"写出来的完成调用"剥掉、保留其后的答案，掐断模仿循环。
- 流式暂存保护（报告者 #3）其自述"可做成可选策略"，未做。

## 改动面（internal/gateway）

1. `textcalls.go`：`dropPseudoCalls` / `withoutPseudoCall` / `historyCall` / `callResult` / `saysAgain` / `plainWords`。
   - 复用 Chat 路径既有机制（`textCallAt` 四种 mark + `paramCall`/`hermesCall`/`glmCall`/`dsmlCall` 读者），不发明新形状解析（LESSONS #823 教训：发明 `<tool_call>{json}` 形状被真实数据打回两次）。
   - 四道门对应报告者四条件：
     - 轮内无结构化部件（ToolCall/ToolResult/Image/File 任一存在即不触发）⇔ "历史助手消息没有真实工具调用"；
     - `historyCall` 读出声明工具的可读参数调用块（`textCallNames(r.Tools)` 门）⇔ "参数 JSON 能按已知 schema 解析"；块右 trim 后以 `>` 收尾（读者吞掉闭合标签）⇔ "文本中有明确的包装结束边界"；
     - args 的 `result` 成员在块后文本中以 `plainWords`（保字母数字、小写化，忽略标点空白大小写——即报告者自己的比对法）包含出现 ⇔ "后续独立答案和 result 高度一致"；
     - 以上任一不满足（裸工具名、JSON 片段、结果不重复）⇔ "仅凭工具名或 JSON 片段不应触发清理"。
   - 重写 = 删 [mark, 块尾) 保留前后文本（保留 lead-in：最小破坏；报告者"只保留最终答案"的字面执行需其真实正文数据定位"执行完毕"标记边界，PR 内说明此选择）。
   - `msgs` 不改（fallback 从同一请求重建，与 `dropSecondAnswers` 同纪律）。
2. `codeassist.go`：`buildCodeAssistSent` 在 `dropSecondAnswers` 之后、`ag`（agent=="antigravity"）门内接入。buildGemini（agent "gemini"）/buildVertex（agent "vertex"）同走此函数但被门挡住——vendor 规则 scope 到报告路由。
3. `textcalls_pseudo_test.go`：fire×3（整块/跨块拼接/invoke+thinking 形状）+ stay×6（真实调用共存/未声明工具/无 result/result 不重复/碎片/user 轮/gemini agent）。

## Not changed（PR 内如实列）

- 接收侧诊断（报告者 #1）：decoder 无 logger 管道，需新 plumbing；且 `<tool_call>` 家族在 Code Assist 路由根本不接 textCallSee 机制，"命中类型计数"无处挂。留待报告者提供真实正文形状后有数据再议。
- 无法覆盖的形状：无 mark 的方言（如 Roo/Cline 的 `attempt_completion
<result>…</result>`）、textArgs 拒收的 `call:default_api:` 变体、``` 围栏内的调用示例（Chat 路径同样不识别围栏，house 既定取舍）。均保守不触发。
- 多块轮（证据显示每轮一个 wrapper，只处理第一块，其余保守保留）。

## Watched 三查

1. antigravity 解码全族：`codeAssistDecoder`（decode/text/flush）**未改**（接收侧零改动）；请求构建族 `buildCodeAssistSent`（唯一入口，+ag 门内一行）、`buildGemini`→agent "gemini" 不触发、`buildVertex`→agent "vertex" 不触发。
2. #3858 PenguinHarness（internal/agent 桌面/CLI 更新域）、#4917 kiro（mover/插件域）与本改动零交集（rg 确认无引用）。
3. 热路径代价：仅 antigravity 请求；每助手轮先过 Role/parts-kind 门 + `<` 预检（无标记文本零分配零扫描），命中才 join+`textCallAt` 线性扫；上限 = 历史体积，被同请求的 envelope marshal 支配。无新 goroutine/锁。

## 验证记录

- RED：no-op 桩下 `TestAntigravityPseudoCallOutOfHistory` 三个 fire 用例 FAIL（伪调用留在正文 = 用户症状）；回退接线（删 ag 门内三行）同样三红。
- GREEN：实现后 9 用例全过（fire 3 + stay 6）。
- 矩阵：见 POST 帖 Verification 表。

## 占坑与时间线

- take 评论：https://github.com/yetone/magpie/issues/5091#issuecomment-6605784505（issue 此前零评论，无在途 PR 占坑，让位闸通过）
- 分支基于 upstream/main 50265256b（94d0fbfcd 后 2 个 library 提交不触及 gateway，已 rebase）。
