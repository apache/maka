# hunt66 Lane A — #2473 验证证据

验证对象：skygunner `9fd7a9d4c087d3c0f4caac1ff3d27a8350577744`（自称 adapted ours, credited as co-author）
我方在途 patch：`910522a70b1633412cc8daf5edf3aebfb967b65e`（分支 hunt30-desktop-title，base 7597c132；gentle ping 6345145900 已发 10-22）
正交项：我方 `b55cf300c9f6164dee7f847cf0213f2bc38f7afe`（#3264 desktop tier，base 398803e3）
本轮基线：upstream/main = `63be47717a9ca91fc89102078a1f1fff3e03e0ce`（复核未动）
worktree：magpie-hunt66-a；cherry-pick 结果 `fd1042a9`

## 1. attribution（只认提交）

```
$ git show --format=fuller 9fd7a9d4 | head
Author:     vincent <webmaster@palmit.com.au>
消息尾部逐字：Co-authored-by: ggbdpq <ggbdpq@gmail.com>
正文："Based on the diagnosis and posted fix by ggbdpq in #2473."
```
PASS。

## 2. 保真对比

- 标题判定行逐字节相同：`title := !tools && desktopTitle(body) && desktopAccepts(asked)`（我方 910522a7 同行同文）。
- `byClaudeCode` 参数移除（desktopTurn 签名 + gateway.go 调用点）与我方一致。
- 注释：保留同一批事实（#1539 分类器、one-token probe #2473、claude -p --system-prompt 形状），篇幅更短。
- `small()` 保留（observe.go:55 仍用，与其/我方判断一致）；`fromClaudeCode` 另有 3 个调用点（gateway.go:1383/3736/4078）不受影响。
- 测试：`TestDesktopProbeKeepsItsModel`（同名）由我方 fixture 改造，从 1 例扩为 4 例（旧 provider off/on × stream/non-stream），pick 文件不动断言与 title 对照组都保留；另有 desktop_turn_test.go 既有用例签名适配 + 给 Default 用例的 title fixture 补 system prompt（修后该用例走在 title 判定路径上，属合理适配）+ docs 增一条 bullet（我方 patch 未动 docs）。
- 结论：**适配（产品码等同我方，测试超集）**，无缩水。

## 3. 消融回红（cherry-pick 9fd7a9d4 → tip 零冲突 → fd1042a9）

消融方式：产品文件 desktop.go / gateway.go 回 tip，desktop_turn_test.go 一并回（其 12 行改动是纯签名适配，须随签名回退才能编译），**新测试 desktop_probe_test.go 保留**（纯 HTTP 层，不触签名）。

RED：
```
$ git checkout 63be4771 -- internal/gateway/desktop.go internal/gateway/gateway.go internal/gateway/desktop_turn_test.go
$ HOME=<scratch> go test -tags nogui -count=1 -p 2 ./internal/gateway -run TestDesktopProbeKeepsItsModel ; echo $?
--- FAIL: TestDesktopProbeKeepsItsModel/old_provider_off_true/stream_false
    desktop_probe_test.go:48: probe: 404 {"error":{"message":"Any is switched off in Magpie, so \"fake/claude-sonnet-5\" is not served; switch it on again in Magpie's Providers to use it",...
--- FAIL: .../old_provider_off_false/stream_false
    probe: 502 {"error":{"message":"Any: Post \"http://127.0.0.1:1/v1/messages\": dial tcp 127.0.0.1:1: connectex: No connection could be made...
--- FAIL: .../old_provider_off_true/stream_true   （同 404）
--- FAIL: .../old_provider_off_false/stream_true  （同 502）
FAIL  EXIT=1
```
404 与 issue 报告逐字同形；502 即 SivanCola 10-20 在 macOS 复现的「打到已关供应商」形状——报告在当前 main（63be4771）仍成立。

GREEN：
```
$ git checkout HEAD -- （同三文件恢复）
ok  	github.com/yetone/magpie/internal/gateway	4.817s   EXIT=0
```

## 4. 漂移与落地

- `git merge-base 9fd7a9d4 63be4771` = `63be4771`：分支正切在 tip 上，零上游漂移。
- cherry-pick 上 tip **零冲突**（fd1042a9，5 files changed, +94/−19）——单 commit 可直接落地。

## 5. 兄弟面（rg 全查）

- `small(` 非 test 调用点：observe.go:55（保留正确）；desktop.go:602 定义。
- `fromClaudeCode` 剩余调用：gateway.go:1383/3736/4078，均非 desktopTurn，正确未动。
- `desktopTitle(` 唯一行为调用点即标题行 desktop.go:474。
- 无漏面。

## 6. 与我方 #3264（b55cf300）的正交性核对

- 两 patch 改**同一行** `title := !tools && aside && desktopAccepts(asked)`，语义正交：#2473 改「什么算标题」（prompt 形状取代 max_tokens）；#3264 追加「tier pick 不算标题」（`&& !desktopTierAsked(asked)`）。
- 实测：`git apply --3way --check`（b55cf300 的 desktop.go hunk 接到 fd1042a9 上）→ 如预期同线冲突，解后合读为 `title := !tools && desktopTitle(body) && desktopAccepts(asked) && !desktopTierAsked(asked)`——两个谓词相加，互不吃掉。
- 三分支关系：ours#2473（910522a7）≈ skygunner#2473（9fd7a9d4，产品码等同、测试超集、可零冲突落地）＞我方在途版的应用便利性；#3264（b55cf300）独立仍需要，任一 #2473 落地后照常可叠加。skygunner 版未吸收/未破坏 tier pick 语义（其 diff 不触 desktopAccepts/desktopTierTurn/tiers）。

## 7. 相称矩阵

| 检查 | 结果 |
| --- | --- |
| 新测试 4 例（-count=1 -tags nogui -p 2） | RED exit 1 / GREEN ok 4.817s |
| Desktop 家族 TestDesktop*/TestClaudeDesktop*/TestHasTools | ok 30.088s exit 0 |
| `-race` | **未跑成**：本机无 gcc（cgo 不可用），与其帖的 -race -count=5 不构成互证 |
| `gofmt -l`（4 个改动文件） | 干净 |
| `go vet -tags nogui ./internal/gateway` | exit 0 |
| gateway 包全量 / 其它包 / 三平台 build | 未跑（改动面 2 产品文件；其帖自称 69 包全量过，本机不复验） |

## 8. 不确定项

- 其 docs bullet 与 fixture 适配的正确性靠读而非独立测试验证（docs 无测试面；Default 用例在 tip+fix 上绿）。
- 我方在途 910522a7 对当前 tip 的 apply 状况本轮未测（本轮对象是对方 commit；我方分支对 7597c132 基线自证过）。
