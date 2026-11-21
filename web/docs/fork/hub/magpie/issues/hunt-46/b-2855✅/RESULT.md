# hunt46-b：magpie#2855 — DeepSeek 阶段留在 Codex rollout 里的 reasoning item 毒源修复

日期：2026-10-18。工作树：/tmp/magpie-h8（分支 `hunt46-b-reasoning-content-openai`，基线 upstream/main `1a3b9268860263f263a2c832b1f9b6d1b57e3fa0`）。提交：`9acbb11fc928ed2722eb065ca771951a0e1e1712`（作者 ggbdpq <ggbdpq@gmail.com>）。patch：`0001-gateway-a-reasoning-item-magpie-hands-Codex-with-its.patch`（`git format-patch -U1` 生成，sha256 前 16 = `62103ce3d6d5e743`，37,815 字节，已在一次性 clone 里 `git am` 验证干净套用且树与提交逐字节一致）。

## 结论（与任务假设的偏差）

任务假设是"magpie 为 Chat-API 上游造的 reasoning item 带 content"。核实结果不是：

1. **Chat 上游（DeepSeek 自家 chat API）路径在 main 上已经是干净形状**：chat 回复的 `reasoning_content` → IR KThink → `responsesEncoder.closeAs` 写 `{id: rs_…, type: reasoning, status: completed, summary: [summary_text]}`，无 content、无 seal。保护性测试 `TestTranslatedChatReasoningCarriesNoContent` 修前修后都是绿的。
2. **真正的毒源在 main 上活得好好的**：Responses-wire 上游（relay 服务 deepseek 模型，`deepseek/deepseek-flash` 正是这类别名）自己的 reasoning item——content 带 reasoning_text、summary 空、自家短 seal（38 字符、非 gAAAA，与 #2855 报告者 rollout 取证逐字段吻合）——被**逐字透传**给 Codex，两条路都在：
   - translated 路径：decoder `output_item.done` 且 `EncryptedContent != ""` → KSealed → 编码器原样字节转发（responses.go 旧 1851-1866）；
   - passthrough 路径：Responses→Responses 同协议字节中继，SSE 原样过（连 IR 都不过）。
3. **#1411 修不了这个场景**：#1411（同一个 400 错误）只在 magpie 中继请求时剥除这类 item；reporter 的场景是 magpie 断开、Codex 直连 OpenAI 回放 rollout，任何网关侧重试都够不着。reporter 版本 v0.1.1285（d783df46）已含 #1411 修复（`git merge-base --is-ancestor` 验证），仍中招——说明毒是 rollout 里存的 item，不是网关请求侧。**reporter 自己的清理（删 25 条 item，其余逐字节保留，9 秒成功回复）既是恢复方式也是诊断证明**；magpie 无法追溯清洗已写入的 rollout，只能从今往后不再种毒。

## 修法

外邦 item 只要 content 非空（OpenAI 家 item 从不带 content——reporter 取证里 GPT 阶段 item 无 content；#1411 的规则"another vendor's text is left out for OpenAI"）就地改造成 magpie 自造形状：**summary 保留文本（原 summary + content 文本合并成一个 summary_text part）、id 保留（流内 added/done 一致）、content 与 encrypted_content 丢弃**。文本不丢，DeepSeek 下一轮要 reasoning 回去时 `withReasoningText` 会从 summary 重建 content。seal 必须丢：外邦 seal OpenAI 解不开，留着就是 invalid_encrypted_content 400（affinity.go 的 foreignReasoning 正是处理它）。

改动面：
- `internal/gateway/reasoning_content.go`（新）：`magpieMadeReasoning`（38 行）、`magpieMadeReasoningRaw`（72 行）、`reasoningTidy`（94 行，照 grok_namespace.go 的 nsTidy 逐行 SSE 重写先例，处理 added/done 和 response.completed 的 output 数组，UseNumber + marshalPlain 保数字格式与其它字节）。
- `internal/gateway/responses.go:1860/1865`（编码器 KSealed 两分支：streamed 分支以 e.itemID 覆盖 id——openItem 会沿用上游 rs_ id，已核对）、`:1990`（renderResponses 整回复路径）。
- `internal/gateway/gateway.go:4549/4616/4677`（passthrough 写链与 flush 链接线，Responses 协议一律生效，OpenAI 自家 item 无 content 不受影响零成本跳过）。
- `docs/subsystems/gateway-routing.md:141`（house rule 原句修订，注明"carries its text"的例外，translated 和 relayed 两路都覆盖）。

## 测试（TDD，reasoning_content_test.go）

- `TestTranslatedChatReasoningCarriesNoContent`：protective，修前绿。
- `TestForeignSealedReasoningGivenCodexCarriesNoContent`：translated 路（web_search 逼翻译），修前 RED（content+seal+空 summary 原样到客户端，done 和 completed 都中），修后绿，id 保持 rs_dsk1。
- `TestForeignSealedReasoningRelayedCarriesNoContent`：passthrough 路（无 tool 纯 turn；`sequence_number` 不存在断言确认真走了中继），修前 RED，修后绿。

## RED/GREEN 与消融、变异证据

- 修前：2 FAIL（外邦 seal 两测），chat 保护测 PASS——直接观察 + 消融双重验证。
- 消融：三个产品文件还原 upstream/main（删新文件），树可编译，恰 2 个外邦测红；从 /tmp/h8-keep 恢复 → 全绿（diff 校验逐字节一致）。
- 变异 (a)：magpieMadeReasoning 给造的 item 附 content → 两外邦测红（"carries its text"，4 处断言命中）。chat 测不受影响属预期——chat 路径不走该函数，其形状由保护测自身断言守（断言器 assertResendable 两个变异都命中，证明断言会响）。
- 变异 (b)：去掉 summary → 两外邦测红（"carries no summary"/"summary text"，4 处命中）。

## 验证矩阵

- `go test -tags nogui -count=1 -run 'TestTranslated|TestReasoning|TestSealed' ./internal/gateway/`：ok 7.9s。
- `go test -tags nogui -count=1 ./internal/gateway/`（全包）：ok 312.4s（后台落盘 /tmp/h8-full-test.log，FULL_EXIT=0）。
- `go test -race -tags nogui -count=1 -run 'TestTranslated|TestReasoning' ./internal/gateway/`：ok 9.4s。
- `gofmt -l internal/gateway/`：空。
- `go vet -tags nogui` darwin/linux/windows：全过。
- `go build -tags nogui -o /dev/null .` 三平台：全过（darwin 有 internal/gui/trayimage_darwin.go 的 cgo -Wenum-conversion 预存告警，与本次无关，未触碰）。
- 预存失败：无（全包全绿）。

## 边界与不确定项（诚实清单）

1. **未用真实 OpenAI/DeepSeek 账号**：reporter 的 rollout 读数（25 条、content reasoning_text、38 字符 seal vs gAAAA）是引用 issue 原文，不是从活线程复算的；reporter 自己也声明没有独立最小复现。
2. **passthrough 的字节中继仍可能种毒的残余面**：本次已用 reasoningTidy 覆盖 passthrough（这是 reporter 最可能的路由形态），但 tidy 只重写含 content 的 reasoning item；seal-only 外邦 item（无 content）仍原样透传——那是 #1044 re-ask / foreign-seal retry / codexInputAs 的既有领地，未动。
3. **改造成的 item（rs_+summary、无 seal）直连回放 OpenAI（store:false）会落 #1008 类 404**（"Item with id 'rs_…' not found"）：走 magpie 时 withoutBareReasoning/codexInputAs 会剥、DeepSeek 回放由 withReasoningText 供文本；断开时这种 item 可逐条删除恢复，好过卡死整线程的 400。
4. **重写事件的 key 顺序**会变（map 重序列化），仅限含毒 item 的事件；Codex 读 JSON 不读 key 序，nsTidy 同款先例。
5. `git format-patch` 用了 `-U1`（默认 -U3 的 hunk 上下文会带进文档既有中文报错原文，违反"零中文"硬规则）；已验证 -U1 patch `git am` 干净套用、树一致。若维护者偏好完整上下文 patch，从提交 `9acbb11f` 重新 format-patch 即可（提交本身不变）。

## 产物

- `RESULT.md`（本文件）
- `2855-comment.body.md`（英文 post-ready，零中文已 grep 验证，内嵌完整 format-patch）
- `0001-gateway-a-reasoning-item-magpie-hands-Codex-with-its.patch`
- 未 push、未在 GitHub 发任何内容。
