# hunt50-a：magpie#2986 — panel-space 测试的按键状态单次读取

## 结论

已完成修复并提交。`TestPanelJoinsFullScreenSpaces` 的按键状态检查原来在固定 500ms 睡眠后**只读一次** `w.IsFocused`、无任何重试（上游 main 的 `internal/gui/panel_space_darwin_test.go:82`），这就是维护者猜的"负载下 AppKit 还没把面板设为 key、检查就读了"的固定窗口，与 #2645 的固定 deadline 同族。修复：改为有界等待（20ms 轮询、至多 5s，与文件里 show/hide 等待同款房间），超时后仍走 63be47717（#2450）的 `sessionKeysPanels` 门——会话本来就不给 key 的照旧跳过，断言语义未弱化。

- 提交：`bea05f94e805d3608a9d3ced03dea65f5be08c07`（分支 `hunt50-a-panel-space`，基于 upstream `79160455`，单提交，作者 ggbdpq <ggbdpq@gmail.com>）
- 补丁：`0001-gui-the-panel-space-check-waits-for-the-keyboard-ins.patch`，sha256 前 16：`9f56769c55c167b6`
- 是否复现：**未自然复现**（负载 125 下 8/8 通过，本机 12 核压不到 ~250）；按规程转为构造性证明，RED/GREEN 双向消融齐全。

## 关键事实（读码所得）

- 单次读取位置：`if !application.InvokeSyncWithResult(w.IsFocused) {`（上游 main 第 82 行），前面是第 70 行固定 `time.Sleep(500 * time.Millisecond)`；失败信息即 issue 原文。
- `w.IsFocused` → Wails `windowIsFocused` → `[nsWindow isKeyWindow]`，读的是实时状态，非缓存。
- Wails 对非激活面板：`Show()` 只 `orderFrontRegardless`；`Focus()` 是 `orderFrontRegardless + makeKeyWindow`。
- 本机（macOS 15.7.4）实测：`Show()` 的 `orderFrontRegardless` 一执行面板**毫秒级即 key**，所以纯时间差的消融（延迟 Focus 1s/3s）都红不了——按键状态在本机不存在"晚到"。
- 本会话 `sessionKeysPanels` 为真（子程序输出无 skip 行），即失败分支在本机可达，RED 消融有效。

## 消融证据（双向）

由于本机按键即时生效，构造"读取时无 key、一秒后才有 key"的状态：检查前把面板 `Hide()`，`time.AfterFunc(1s)` 再 `Show().Focus()`。

- **RED**（旧单次读取 + 上述构造）：`--- FAIL: TestPanelJoinsFullScreenSpaces`，子程序输出 `panel space: made at start: the panel shown doesn't take the keyboard`（issue 原文），FAIL 2.622s。
- **GREEN**（修复 + 完全相同的构造）：`ok github.com/yetone/magpie/internal/gui 4.698s`——轮询等到按键状态落地。
- 无效消融记录（写码前的两次尝试，均为 GREEN，证明本机按键即时性）：拆开 Show/Focus 延迟 1s、延迟 3s，旧代码都通过。

## 验证矩阵

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 修复前基线单独 ×1 | `go test -count=1 -run TestPanelJoinsFullScreenSpaces ./internal/gui/` | ok 1.45s |
| 修复前单独 ×5 | 同上 `-count=5` | ok 7.7s |
| 修复前负载 ×3 | 150 个 `yes` 燃烧进程，load 101→125，`-count=3` | ok 9.5s（未复现） |
| 消融 RED | 旧读取 + 构造晚 key | FAIL，issue 原文 |
| 消融 GREEN | 修复 + 同构造 | ok 4.7s |
| 修复后单独 ×3 | `go test -count=1 -run TestPanelJoinsFullScreenSpaces ./internal/gui/` | ok 3.1s / 2.8s / 2.7s |
| gofmt | `gofmt -l internal/gui/` | 干净 |
| vet nogui darwin/linux/windows | `go vet -tags nogui ./internal/gui/`（后两个 GOOS=linux/windows） | 全过（trayimage_darwin.go 的 `-Wenum-conversion` 为预存警告） |
| vet cgo | `go vet ./internal/gui/`（编译 darwin 测试文件本体） | 过 |
| WindowServer | — | 可用，全部为真实 AppKit 运行 |

本机环境：macOS 15.7.4 arm64（24G517），go1.26.8，工作树 /tmp/magpie-h25（未触碰主 clone）。

## 不确定项

1. **未在 macOS 26.2 + load ~250 复现**（issue 的原始环境）：本机系统旧一代、核数压不够，且 macOS 15 的按键语义宽松（orderFront 即 key）；修复对"晚到按键"的有效性由构造消融背书，非自然复现。
2. **消融手段与真实负载机制不完全同构**：构造的是"读取时刻无 key、随后有 key"这一可观测状态（与 issue 失败时的状态一致），而非复现 WindowServer 层的延迟机制——后者在本机 OS 上不可达。
3. **post-show 的 `appFrontmost` 检查**（同一 500ms 固定睡眠后）理论上也可能错过晚到的激活，属同族隐患但无 reported red，本次未动，已在英文评论 Siblings 节说明。
4. 未跑 `-race`（纯测试侧轮询改动，无产品并发变化）与全量 45m 套件。

## 产物

- `0001-gui-the-panel-space-check-waits-for-the-keyboard-ins.patch` — format-patch，`git am` 可用
- `2986-comment.body.md` — 英文待发评论（无中文，内嵌完整补丁，已 diff 核对与 patch 文件一致）
- 未推送、未发帖（按规程）
