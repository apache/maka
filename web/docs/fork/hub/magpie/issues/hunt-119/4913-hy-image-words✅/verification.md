# hunt-119 车道 C：#4913 hy-image 进 ImagesAPI 词表

- issue: https://github.com/yetone/magpie/issues/4913
- 分支: fix/4913-hy-image-words（fork ggbdpq/magpie），base a3768cdd1，head 67506a05f
- worktree: /tmp/mg119-c
- take: https://github.com/yetone/magpie/issues/4913#issuecomment-6582134342

## 改动（一词一测试）

1. `internal/catalog/catalog.go` — `ImagesAPI` 词表加 `"hy-image"`，doc 注释补 Loomy 一句。
2. `internal/gateway/draw_loomy_test.go` — 新增 `TestLoomyPluginDraws`（Loomy 三图像模型 fake 插件：Drawers 列全三个 + Hy-Image 走 images API、chat 不被问）。
3. `internal/plugin/testdata/fake/index.js` — `FAKE_LOOMY` 分支注入三个模型（测试支撑）。

## TDD 记录

- RED（词表未改）：`drawers [doubao-seedream-5-lite qwen-image-3.0-pro], want [Hy-Image-3.5-preview doubao-seedream-5-lite qwen-image-3.0-pro]` —— 与 issue 症状一致（hy-image 缺席）。
- GREEN（加一词后）：`ok github.com/yetone/magpie/internal/gateway`。
- 消融（提交后只回退 catalog.go）：回红，红因正是词表一词；恢复后工作区干净。

## 验证矩阵（-tags nogui）

| 检查 | 结果 |
| --- | --- |
| gofmt（两 Go 文件） | 干净 |
| go vet ./... / GOOS=linux vet -tags nogui / GOOS=windows vet | 三连退出码 0（darwin gui cgo warning 预存噪音） |
| go build . / CGO_ENABLED=0 GOOS=linux -tags nogui / GOOS=windows | 三连退出码 0（ld macOS version warning 本机工具链噪音） |
| go test ./internal/catalog -tags nogui | ok 2.3s |
| go test ./internal/provider -tags nogui | ok 135.9s |
| go test ./internal/gateway -tags nogui | 首轮 10m 默认超时 panic（三车道并发抢 CPU）；-timeout 25m 重跑 740.994s，唯一红 `TestCodexPoolSaysTheClientsVersion`（定性：预存环境依赖——测试注释自declared前提 "0.161.0 is newer than any installed here"，本机 codex-cli 0.166.0 已打破，`codexVersion()` 探测到 0.165/0.166 后断言红；单跑 ok 1.0s；与本单零交集）。`TestLoomyPluginDraws` 在两轮全量中均绿 |
| race | 未跑：无并发改动 |

## Watched 三查

- 词表其它消费出口：`detect.go:258`（探测标注 hy-image 为图像模型，正确）、`detect.go:340`（不再当 chat 试测模型，正确）、`draw.go:315`（本单目标）、`draw.go:918/922 viaFor`（hy-image 转 viaImages，正确）、`draw.go:1814`（不再误入 Gemini 分支，正确）、`test.go:307`（模型测试发图片请求，正确）。DrawsID 消费方（public.go:71、live.go:641、codeassist.go:570/759、draw.go:294/351、test.go:433、search.go:154）全部不触 ImagesAPI，行为不变。新词只命中含 hy-image 的 id；此类 id 被 DrawsID 宽词 "image" 早已判为 drawer，仅提问端点移动。
- 读失败语义：词表 Contains 纯函数，无 IO 无错误路径。
- 热路径代价：词表 16→17 词，每次 draw 多一次 strings.Contains，零增量级。

## 不扩面项（留帖内建议）

- WorkBuddy 的 wbDrawers hardcode 路径在通用词表补齐后存在理由减弱，是否退场是维护者的取舍，本单不动。
- 编辑（/images/edits）路径未在 Loomy fake 上测（issue 只报 generations 200）。

## patch

- 文件: 67506a05f-draw-loomy-hy-image.patch（format-patch，git am 可直接套）
- SHA-256 first 16: 0988fa0bcf086516

## 发布

- push: origin（ggbdpq/magpie）fix/4913-hy-image-words，ls-remote 核对 head 67506a05f
- 帖: https://github.com/yetone/magpie/issues/4913#issuecomment-6583123837（POST 一次成功，GET 回读 len 11847、author ggbdpq、AI-written/SHA/branch/patch From/Co-authored-by/Generated-by 全在场）
- 五项自检：AI-written ×1、Co-authored-by ×1、SHA 行 ×1、帖内 patch 嵌入无丢失（== 文件 rstrip）、git am 干跑（干净 a3768cdd1 → Applying 成功 → 树与原提交零差异）
- 门禁：fetch 后 upstream/main 仍 a3768cdd1（base 不漂移）；open PR grep 4913/hy-image/ImagesAPI 全空；issue 评论仅己方 take

