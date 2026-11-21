# #2413 原始依据与产品意图（2026-10-17 复核）

- 固定代码基线：`6f950653fcdb46c73044a071328cdc508f12ccef`。所有修订只在 `/private/tmp/magpie-quality-20261017-2413`；主 clone 和其他 worktree 未改。
- 旧拒绝不是偶然行为：`0b0f258c0` 的导入功能初版明确把 Gemini-protocol relays 列为不可导入；当前 `ccSwitchEntry` 与 `readAlma` 仍保留此分支。
- 支持能力确实随后变化：[维护者在 #1346 的说明](https://github.com/yetone/magpie/issues/1346) 与 `844b9ca3` 引入自定义 Gemini API，中转地址、密钥请求头和模型查询均属于已存在的产品能力。本轮网页读取可见维护者明确说明既支持官方 Gemini base 也支持 relay base，并有后续中转实测记录。
- 固定 main 的 `docs/subsystems/providers-accounts.md` Provider 条目已描述自定义 `Gemini` URL 支持 Google API 或兼容服务。`internal/provider/gemini_api.go` 和 `gemini_api_test.go` 提供归一化、鉴权、模型列表行为；导入路径应复用，不新增协议翻译层。
- #2413 的本地归档评论列表为空；本轮网页读取未见维护者明确要求继续屏蔽该导入。由“协议能力已经支持”推断“旧导入拒绝可移除”是有根据的建议，但不等于维护者已批准该产品决策。
- `319b86fe` 已进入 main，修过 Gemini provider 的同账户识别。本轮不再覆盖其既有改动，只在新导入路径保留并回归它。

## 来源边界

本单源于代码审计、可控 SQLite fixture，不是本人使用真实 CC Switch/Alma 触发的失败。fixture 遵循当前读取器要求的字段，但未取得真实安装导出的数据库；实际应用新旧版本的 schema 兼容性尚未验证。预期值来自显式输入和已存在的 `Provider.Gemini` / `GeminiBase` 契约，不把模拟请求当真实供应商拒绝证据。
