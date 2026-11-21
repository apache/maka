# #3937 gemini genconfig 透传 — Lane F 交付日志（2026-11-04）

## 结局：任务完成（patch 已发布）

- Issue: yetone/magpie#3937（gateway 翻译丢 Gemini generationConfig 未知字段）
- 占坑: take 评论 6616013623
- patch 帖: https://github.com/yetone/magpie/issues/3937#issuecomment-6616364189（GET 回读八要素全中）
- fork 分支: `fix/3937-gemini-genconfig`，head `6df21df128b0ecd4b5d1960712542c57458b9423`（父 = upstream/main tip `d8b3749ef`）
- patch: `0001-gateway-...patch`，SHA-256 前 16 `cf9787bbe5254074`
- 帖稿留档: `comment-patch.md`

## 根因与修法

parseGemini 类型化解码只留认识的键（maxOutputTokens/temperature/topP/stopSequences/structured output/thinkingConfig/imageConfig），buildCodeAssistSent 重造 generationConfig 只写认识的键，IR 无槽位。修法（同 #3820 ImageConfig 先例）：

1. `ir.go`：Request 加 `GenConfig map[string]json.RawMessage`（未知键槽位）。
2. `gemini.go parseGemini`：camel 化后的 body 再解码一次 `map[string]RawMessage`，滤掉 `genReadOrBuilt`（9 个认识键）存入。
3. `gemini.go geminiRequest`：merge-if-absent 合并进上游 generationConfig——magpie 主动设置的键（draw 模型 responseModalities）覆盖客户端原值，未知键原样透传（snake_case 已被 geminiCamel 归一）。

落点选 `geminiRequest` 的原因：只有 buildGemini（Gemini API）和 buildVertex（Vertex AI）走它，两者原生 Gemini schema 可承接；Code Assist/Antigravity 信封无文档拼写（报告者原话），不透传。

## 验证

- RED→GREEN：TestGeminiGenConfigReachesTheGeminiAPI（报告者九字段/snake_case/与认识键并存/none asked none sent）+ TestGeminiGenConfigDrawModelKeepsMagpiesModalities（客户端 ["TEXT"] 被 magpie ["TEXT","IMAGE"] 覆盖、topK 并存）
- 消融：产品文件 checkout 父提交、测试保留 → 回红；恢复 HEAD → 绿
- 全量 `go test -tags nogui -timeout 25m ./internal/gateway/`：ok 623s，0 失败（预存红清单零命中）
- race（TestGemini* 定向）/gofmt/vet/build ./... 全绿

## 兄弟面 rg 全查（改/不改）

- 改：gemini.go（parseGemini+geminiRequest）、ir.go（加槽）
- 不改：codeassist.go buildCodeAssistSent（Code Assist/Antigravity 信封不透传）；vertex.go（经 geminiRequest 自动获益）；limit.go withTokenFloor（map[RawMessage] 保键）；maxoutput.go withMaxOutput/withReplyCap（map[string]any 保键，withFields 整键替换不丢键）；quiet.go（只删 thinkingConfig）；draw.go:1853（内部直连，非翻译路径）；gateway.go:2071（countTokens 本地估算，不发上游）；chat/responses/anthropic builders（跨协议不透传，IR 不建模对应字段）

## 未覆盖（帖内已声明 follow-up）

顶层 `safetySettings`、`cachedContent` 不在本单（issue 标题限 generationConfig）；跨协议（Gemini→Chat/Responses/Anthropic）字段映射是逐协议拼写工程，报告者也标注为"decision, not a fix"级别。
