# WP7 · 一致性场景 + 剧本假 provider

**目标**：给 WP2–WP6 提供跨语言可执行的验收：SC-005 ～ SC-010。

**langchain 对标**：无直接对应（langchain 用单测和 LangSmith 评测）。这是 coding-agent 自己的长处，保持。

**归属文件**：`conformance/adapters/shared.mjs`、`conformance/scenarios/SC-005…SC-010-*.mjs`、`docs/conformance-schema.md`（新增 `steps` 剧本说明）、`docs/conformance-normalization-policy.md`（TS 先行的 E 条目）。

**接口依赖**：WP0（只依赖事件名和 spec 草案，不依赖实现）。

## 步骤

1. `shared.mjs`：`startSink` 支持 `model_script.kind === "steps"`，第 N 次请求回放 `steps[N-1]`；超出剧本返回 500（与现状一致，视为漂移证据）。
2. `encodeOpenaiSse` 支持 `raw_arguments`（原样字符串）和 `finish_reason` 覆盖；`arguments` 对象路径保持不变。
3. sink 记录每个请求体的消息字符数和是否带 `tools`，供 normalize 使用。
4. 按 [04 §3](../04-测试与验收.md) 写 6 个场景，全部 `maturity: "draft"`，期望只锚 spec 草案，不抄 TS 实现。
5. normalization-policy 新增 E 条目：这 6 个场景对非 TS 版本判 ALLOW_DIFF，写明原因"ADR-003 TS 先行"和复查日期。
6. 在 develop 上跑一遍，确认 TS 版对 SC-005～010 都是 DRIFT（证明场景能抓住问题），把报告附在 PR。

## Cursor 提示词

```text
仓库 coding-agent，分支 feat/wp7-conformance（从已合并 WP0 的 develop 拉）。在仓库根目录工作。
目标：扩展一致性层的假 provider 支持多步剧本，并新增 SC-005～SC-010 六个 draft 场景。
参考：附带的 04-测试与验收.md §3、工作包/WP7；格式参考 conformance/scenarios/SC-001-plan-mode.mjs 和 SC-004A。
1. conformance/adapters/shared.mjs：startSink 新增 model_script.kind="steps"（按请求序号回放）；encodeOpenaiSse 支持 raw_arguments 与 finish_reason 覆盖；记录每个请求的消息字符数和是否带 tools。旧的 tool-then-text 剧本行为不变。
2. 新增场景：SC-005 轮内上下文治理、SC-006 非法工具参数、SC-007 截断参数、SC-008 授权粒度（s 与 a 两臂）、SC-009 轮次上限、SC-010 崩溃恢复。maturity 全部 "draft"；expect 只锚 specs 修订草案，不写实现细节词（遵守 R-schema-1 零实现词门）。
3. docs/conformance-schema.md 补 steps 剧本字段说明；docs/conformance-normalization-policy.md 新增 E 条目：上述场景非 TS 版本判 ALLOW_DIFF（ADR-003 TS 先行），写复查日期。
4. 运行 node conformance/run.mjs SC-001 SC-002A SC-004A 确认旧场景结果不变；再跑新场景，TS 版预期 DRIFT，把报告路径写进 PR。
硬约束：适配器只采集不判定；不可归类的差异一律 DRIFT；零新增依赖；不改任何 impls/ 下的实现代码。
完成后输出：改动文件、新旧场景运行结果。
