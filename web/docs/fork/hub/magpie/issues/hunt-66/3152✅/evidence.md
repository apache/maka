# #3152 验证证据（Lane E，hunt66）

对象 commit：skygunner deefacd28c807b3e66e4183605ef44ecd1eada7b。我方原 patch：4c03aaac（帖 6321189749）。

## 1. attribution 实查

- Author: vincent <webmaster@palmit.com.au>
- trailer 逐字摘录：`Co-authored-by: ggbdpq <ggbdpq@gmail.com>`（命中）
- message 声明：`Adapt ggbdpq 4c03aaacdf0fe0cccab5000e9bdacecc82371f3e with its regression matrix.`

## 2. 保真对比（补丁文本互比）

`git diff 4c03aaac^ 4c03aaac` vs `git diff deefacd2^ deefacd2`：

- stat 完全一致：同 5 文件（gateway-routing.md / gateway.go / grok_integral.go / grok_integral_test.go / ir.go），+110/−109。
- 两补丁文本 diff 仅：index 行、hunk 头行号漂移（159→180、4707→4718、5819→5860、6208→6264、6235→6291）、一处基线上下文行（textcalls 文档 bullet，对方基线更新含 DSML close 段落）。
- **改动行逐字同一**。
- 重点核查：复用既有 wholeNums（非另立判定）✓；`Request.Grok`/`grokServed` 删除（deefacd2 树 `git grep grokServed` 零残留）✓；grokModel 保留给 grok_schema ✓；浮点边界（2500.5/2.50/2.5e3/1.0e3/字符串 "4000.0"）由 integralCases edges 覆盖 ✓。
- 结论：**逐字同一（改动行）**，仅基线上下文漂移。

## 3. 漂移与落地

- deefacd2^ = 852182f6，merge-base = 63be4771，`63be4771..852182f6` = 475（对方基点领先 tip 475 提交）；我方 4c03aaac 基点 f5b015742 领先 tip 358。
- cherry-pick 到 tip：**两处冲突**（docs/subsystems/gateway-routing.md 段落位移、internal/gateway/ir.go 字段上下文——tip 无 LoadedInPlace，#2660 是 tip 之后上游提交）。
- 解决：ir.go = 摘除 Grok 字段整块、不引入 LoadedInPlace；docs = 新 Grok→every-model 段替换 tip 段、后三条 bullet 保 tip 版。
- 过程事故与修复：第一次 `git cherry-pick --continue` 带冲突标记误入提交（python 断言失败未写文件后仍 continue）；发现后从带标记版重新解析（修复了首版解析把 images bullet 与 Group members bullet 粘成一行的 bug：merged 末尾缺换行），`git commit --amend` 后 stat 恢复 +110/−109 与原 patch 一致。本地 commit 757c0806。

## 4. GREEN

- 测试名（grep -n '^func Test' grok_integral_test.go）：TestWholeNumsAnyCut / TestGrokCallsGiveCodexIntegers / TestGrokCallsGiveCodexIntegersTranslated / TestGrokCallsGiveIntegersOnEveryProtocol / TestOtherModelsCallsGetCodexIntegers / TestToolSearchWholeFloatLimitGivesCodexIntegers / TestGrokModel
- 命令：`go test -tags nogui -count=1 -run '^(上述 7 名)$' ./internal/gateway/`
- 结果：`ok github.com/yetone/magpie/internal/gateway 51.184s`，exit=0

## 5. 消融回红（摘 gateway.go / grok_integral.go / ir.go 三产品文件回 HEAD^，留测试）

命令：`go test -tags nogui -count=1 -run '^(TestOtherModelsCallsGetCodexIntegers|TestToolSearchWholeFloatLimitGivesCodexIntegers)$' ./internal/gateway/`

RED 原文（ablation-red.log）：

```
--- FAIL: TestOtherModelsCallsGetCodexIntegers (0.82s)
--- FAIL: TestToolSearchWholeFloatLimitGivesCodexIntegers (0.16s)
    grok_integral_test.go:671: deltas: yield_time_ms is 2500.0 in {"cmd":"...","yield_time_ms":2500.0,"max_output_tokens":4000.0}, want 2500
    grok_integral_test.go:703: deltas: limit is 8.0 in {"query":"exa web search","limit":8.0}, want 8
FAIL  exit=1
```

与 skygunner 帖内宣称的两条 RED 逐字同形。恢复后同命令：`ok ... 7.854s`，exit=0。

## 6. 兄弟面

- tip 上 grokServed 消费点 3 处（gateway.go:5418 translate、5793 encoder、5820 render）全被改动盖住；ir.go Request.Grok 字段删除。
- wholeArgs 调用方：wholeResult（grok_integral.go:149）、intTidy（:397）、测试——全覆盖。
- Gemini 无 arguments string（对象形参），intTidy 无 Gemini case，未加（与帖内一致）。
- gathered route 走同一 passthrough 链（帖内声明，本机未单独测）。

## 7. 质量门

- gofmt -l 四个 .go 文件 → 空；`go vet -tags nogui ./internal/gateway/` → 净（exit=0）。
- 未跑：全量 gateway 包（我方原帖 558s 量级，本轮按协议只跑定向）、真实 muse-spark/Codex 会话（双方都未跑）。
