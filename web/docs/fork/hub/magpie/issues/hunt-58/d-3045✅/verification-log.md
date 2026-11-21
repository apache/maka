# hunt58 Lane D — issue #3045 验证日志

- 分支：`hunt58-d-3045-codex-images-budget`（worktree /tmp/magpie-r58-d）
- 基线：`f5b0157420a4491f6e707b49a8af8e87ea8050a1`（=upstream/main）
- 提交：`86f9707e8058848662e35db0b85462e35751122a`（单文件 internal/gateway/codex_images_test.go，15+/2-）
- patch：`0001-gateway-the-past-the-budget-images-test-counts-its-b.patch`，SHA-256 前 16 = `9d00b064fd563e89`
- 本机：macOS darwin/arm64，启动器 go1.25.5，go.mod 锁 go1.26.8（GOTOOLCHAIN=auto 解析），另显式 GOTOOLCHAIN=go1.27.0
- 日志文件在 /tmp/magpie-r58-log/（会话临时目录，重要输出摘录如下）

## 定性

判定 (c) 测试的病，非产品回归。依据：
1. git log：测试与所钉的预算缓存同源于 11173c8a，两文件自引入后测试侧未被改过；产品侧后来只有 3eee19b0/a9304efe（头部/解码计账），与本红无因果（1.26 下测试绿）。
2. 实测翻转（临时测量测试，已删）：go1.26.8 fitted 278–282（one=280，预算 2940，末 11 张和 3088 → 11 放不下 → 10 kept → 绿）；go1.27.0 fitted 336–387（one=384，预算 4032，末 11 张和 4008 → 11 放得下 → 11 kept → turn 2 重做 19 → 红）。
3. 机理：预算 = 10.5 × 首张 fit 尺寸，假设 30 张同尺寸（实际差几个字节）；stdlib PNG 编码器跨版本字节漂移决定 LRU 边界落点（10↔11 翻转）。
4. 侦察简报"本机单跑即可复现"不成立：默认工具链（1.26.8）单跑 PASS；红只在 1.27。

## 基线红（GOTOOLCHAIN=go1.27.0，修复前）

    --- FAIL: TestCodexFittedImagesPastTheBudget (0.02s)
        codex_images_test.go:362: turn 2 made 19 of 30 images, with 10 kept
        codex_images_test.go:362: turn 3 made 19 of 30 images, with 10 kept
    FAIL
    FAIL	github.com/yetone/magpie/internal/gateway	1.017s
    （exit 1）

基线默认工具链（go1.26.8）：`ok ... 1.508s`，exit 0。

## 修后绿

- go1.26.8 定向 ×2：ok 1.030s / ok 1.044s，exit 0 ×2
- GOTOOLCHAIN=go1.27.0 定向 ×2：ok 1.685s / ok 1.037s，exit 0 ×2
- -race -count=5 定向：ok 4.118s，exit 0
- TestCodex 家族：go1.26.8 ok 28.134s；go1.27.0 ok 24.451s，exit 0 ×2
- gateway 全包（手工 temp HOME + GOPATH/GOMODCACHE/GOCACHE 固定；包 TestMain 另有 HOME 隔离）：ok 552.980s，exit 0

## 消融（回红）

修复文件移开、测试文件还原到 f5b01574 → GOTOOLCHAIN=go1.27.0 定向：

    codex_images_test.go:362: turn 2 made 19 of 30 images, with 10 kept
    codex_images_test.go:362: turn 3 made 19 of 30 images, with 10 kept
    FAIL（exit 1）

恢复修复文件 → 绿（见上）。

## Watched 破坏（修复后敏感性确认）

预算从"末 10 张 + 倒数第 11 张的一半"人为放宽到"整张"（半→整）→ 11 张放得下 → go1.27.0 定向回红：

    codex_images_test.go:375: turn 3 made 19 of 30 images, with 10 kept
    FAIL（exit 1）

还原后绿。测试仍咬人。

## 兄弟用例清查（codex_images_test.go 全部 16 个测试）

唯一定点即 TestCodexFittedImagesPastTheBudget。其余 15 个不带同一缺陷：
- TestCodexScreenshotsAreNotFittedAgainEachTurn、TestCodexFittingLeavesATurnThatFitsAsItWas、TestCodexFittedImagesLetGoWhenIdle：freshFitted(t, fittedBudget) 全额 256 MiB，无逐出边界；idle 用例断言值是自测的同一尺寸
- TestCodexAHeaderAloneCantHoldPastTheBudget、TestCodexFourHeadersInOneRequestCantHoldTheHeap、TestCodexRealScreenshotsFitBytesTheyHold、TestCodexAHeaderBehindExifIsCounted：活测量对限值/自洽数学，无跨张字节恒等假设
- TestCodexFittingHoldsTheBudget：纯批处理函数 fitInHand 喂合成 MB 值
- TestCodexImageSizeAsCodex、TestCodexScreenshotSizedAsCodex、TestCodexImagesSizedInEveryPlace、TestCodexImagesThatFitGoAsTheyCame、TestCodexImagesOnlyForChatGPT、TestCodexAccountGetsScreenshotAtCodexSize：无缓存预算算术
家族双工具链实跑全绿佐证。

## 矩阵（命令 → 退出码）

- go test -tags nogui -count=1 -run '^TestCodexFittedImagesPastTheBudget$' ./internal/gateway/（1.26.8 ×2 / 1.27.0 ×2）→ 0 0 0 0
- GOTOOLCHAIN=go1.27.0 同上（基线还原态）→ 1（消融红）
- go test -tags nogui -race -count=5 -run '^TestCodexFittedImagesPastTheBudget$' ./internal/gateway/ → 0
- go test -tags nogui -count=1 -run TestCodex ./internal/gateway/（1.26.8 / 1.27.0）→ 0 / 0
- temp HOME 包装 go test -tags nogui -count=1 ./internal/gateway/ → 0（552.980s）
- gofmt -l internal/gateway/codex_images_test.go → 0（无输出）
- go vet ./... → 0（internal/gui/trayimage_darwin.go:112 预存 cgo -Wenum-conversion 警告，本单未触碰该文件）
- GOOS=linux go vet -tags nogui ./... → 0；GOOS=windows go vet ./... → 0
- go build ./... → 0；GOOS=linux go build -tags nogui ./... → 0；GOOS=windows go build ./... → 0
- git am 演练：临时 worktree 自 f5b01574 施 patch → 树哈希 d691ad5fd03fb65ea3dd540cc27928f5ba88446b 与提交树一致（内容逐字节同）

## 未跑项

- 全仓 go test -tags nogui ./...（本单矩阵为触达包全量；改动仅 internal/gateway 一个测试文件）
- 未 bisect Go 1.27 stdlib 具体哪个 CL 挪了 PNG 字节（翻转已证实，元凶 CL 未定位）
- 未跑除 1.26.8/1.27.0 外的工具链
- 未 push、未发帖（hunt 规矩）

## 交付物

- 提交 86f9707e（分支 hunt58-d-3045-codex-images-budget）
- 0001-gateway-the-past-the-budget-images-test-counts-its-b.patch（git am 原样可施，已演练）
- 3045-comment.body.md（英文发布稿，patch 已内嵌，零中文，Attribution/SHA-256/分支行齐）
- 本日志
