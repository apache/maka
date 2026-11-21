# hunt52-d · #3045 · TestCodexFittedImagesPastTheBudget 单跑红

日期：2026-10-20。工作区 `/tmp/magpie-h34`，分支 `hunt52-d-codex-images-red`，基线 upstream/main `dee5c9d7`。

## 结论

**(c) 测试的病，不是产品回归。** 测试用 `shots[0]` 一张图的 fitted 字节数当"单位一"，预算取 `10.5*one`，隐含假设 30 张图 fitted 后同尺寸。实际各差几字节，而 LRU 边界落点由这几个字节决定；go1.27 的 stdlib PNG 编码器输出挪了几字节，尾部 11 张装得进预算 → 保留 11 张、重做 19 张 → 报障输出。产品（字节预算 LRU 缓存）在两个工具链上都按契约工作。

证据链：
- 两文件（`codex_images.go` / `codex_images_test.go`）自 `11173c8a`（2026-10-18，测试与缓存同期引入）后从未改动；`git log -S "made"` 也只命中该提交。不存在产品提交漂移。
- 实测 fitted 尺寸（探针测试，跑完已删）：
  - go1.26.8 / go1.26.9：278–282 字节，`one=280`，预算 2940，尾部 11 张和 3088 > 2940 → 留 10 → 绿；
  - go1.27.0：336–387 字节，`one=384`，预算 4032，尾部 11 张和 4008 ≤ 4032 → 留 11 → 红（与 issue 输出一字不差）。
- go.mod 要求 `go 1.26.8`，本地 go1.27 直接满足不触发工具链切换——报障者"fetched today 仍红"与"本机 1.26 绿"由此调和。

## 改动

仅 `internal/gateway/codex_images_test.go` 的 `TestCodexFittedImagesPastTheBudget`：预算改为按 30 张图**实际** fitted 尺寸计——末尾 10 张之和 + 倒数第 11 张的一半。"留 10 不留 11"由此对任何工具链**按构造成立**（末 10 张必装入；末 11 张必超出恰好半个第 11 张；LRU 每轮考察的 11 张集恒为下标 19..29，与尺寸无关），不再赌编码器噪声落边。钉住的期望（turn1=30、turn>1=20、held≤budget）不变。

## RED / GREEN

- RED（修前，`dee5c9d7`，go1.27.0）：`go test -tags nogui -count=1 -run '^TestCodexFittedImagesPastTheBudget$' ./internal/gateway/` → `turn 2 made 19 of 30 images, with 10 kept` + turn 3 同行，exit 1，与 issue 逐字节一致。
- GREEN（修后）：go1.26.8 单跑 ×2 ok；go1.27.0 单跑 ok；同一树修前 1.26 本就绿（解释了为何多数机器看不见）。

## 验证矩阵

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 修前红（go1.27.0） | `GOTOOLCHAIN=go1.27.0 go test -tags nogui -count=1 -run '^TestCodexFittedImagesPastTheBudget$' ./internal/gateway/` | FAIL 如报障，exit 1 |
| 修前绿（go1.26.8/1.26.9） | 同上（无 GOTOOLCHAIN） | `ok`，exit 0 |
| 修后单跑 ×2（go1.26.8） | 同上 | `ok`/`ok`，exit 0 |
| 修后单跑（go1.27.0） | 同上 + GOTOOLCHAIN | `ok`，exit 0 |
| TestCodex 家族（go1.26.8） | `go test -tags nogui -count=1 -run TestCodex -v ./internal/gateway/` | 全过（含 codex_images_test.go 全部 9 测），exit 0 |
| 图像测试（go1.27.0） | `GOTOOLCHAIN=go1.27.0 go test -tags nogui -run 'TestCodexImage|TestCodexImages|TestCodexScreenshot|TestCodexScreenshots|TestCodexFitted' -v` | 8/8 过，exit 0 |
| gateway 全包 | `go test -tags nogui -count=1 ./internal/gateway/`（后台） | `ok 317.86s`，exit 0，无超时 |
| gofmt | `gofmt -l internal/gateway/codex_images_test.go` | 干净 |
| vet | darwin / GOOS=linux / GOOS=windows，`-tags nogui` | 三平台全过 |

产品代码零改动，无需单独构建；vet 已含测试在内编译该包。

## 同类测试排查

`TestCodexScreenshotsAreNotFittedAgainEachTurn` / `TestCodexFittedImagesLetGoWhenIdle` 用全量 256MiB 预算（无驱逐边界），后者断言的尺寸是自测的；其余 6 个 codex_images 测试不涉缓存预算算术。两工具链下全跑过，只有本测试敏感。

## 提交与工件

- 提交：`9fe9a64276eacc893dc3718976ce3dd08d3863a8`，作者 `ggbdpq <ggbdpq@gmail.com>`，单提交基于 `dee5c9d7`。
- patch：`0001-gateway-the-past-the-budget-images-test-counts-its-b.patch`，sha256 前 16 位 `3c1d25587d01359a`。
- 英文评论稿：`3045-comment.body.md`（已 grep 确认零中文）。

## 不确定项

- 未二分定位 go1.27 里挪动 PNG 字节的具体 stdlib 变更（image/png 还是 compress/flate）；工具链翻转已实证，元凶 CL 未指认。
- 只验证了 go1.26.8、go1.26.9、go1.27.0 三个工具链；新预算虽按构造成立，无法穷举所有版本。
- GitHub CI 未跑（按 hunt 纪律不推送不发帖）。
- 消融（修复回退→红）未重复跑：修前 go1.27.0 的红即原始代码的红，修后同工具链转绿已构成红↔绿翻转证据。
