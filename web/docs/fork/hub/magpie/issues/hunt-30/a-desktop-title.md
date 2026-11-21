# #2473 补丁评论草稿（hunt30 A 路）

接单 claim：https://github.com/yetone/magpie/issues/2473#issuecomment-6207645241
分支：ggbdpq/magpie `hunt30-desktop-title`（基于 7597c132）
提交：910522a7

## 评论区正文

按报告的根因修了，红绿与消融都在 7597c132 上做过：

- `desktopTurn` 不再拿 `max_tokens <= 4096` 当标题，改用 `desktopTitle(body)` 的正向识别（标题 prompt，Desktop 自有客户端与 Claude Code 的 `--system-prompt` 两种形状都已覆盖）；其余无 tools 的请求一律保留自己点名的模型。`byClaudeCode` 参数因此冗余，已移除；`small()` 保留（observe.go 还在用）。
- 回归 `TestDesktopProbeKeepsItsModel`：探测打在已被服务的模型上、`claude-desktop.model` 里留着已关供应商的 pick——修前 404（"Any is switched off in Magpie, so … is not served…"，与报告同形），修后探测用自己的模型且不写 pick；标题仍跟随会话 pick。

| 检查 | 结果 |
| --- | --- |
| 修前红（7597c132） | 404 "Any is switched off in Magpie, so \"fake/claude-sonnet-5\" is not served…" |
| 修后同测试 | 绿 |
| 消融（checkout 910522a7~1 的 desktop.go/gateway.go/desktop_turn_test.go + 仅追加新测试） | 回红，同上形状 |
| TestDesktop* / TestClaudeDesktop* / TestHasTools（-tags nogui -p 2） | ok |
| go test ./internal/gateway 全量（-tags nogui -p 2 -timeout 45m） | 〈套件结果〉 |
| gofmt -l internal/ | 干净 |
| go vet ./... darwin / GOOS=linux -tags nogui / GOOS=windows | 干净（trayimage_darwin 的 cgo -Wenum-conversion 警告为本机已知环境噪音） |
| go build darwin / linux(nogui) / windows | ok |

补丁与分支：[ggbdpq/magpie 分支 `hunt30-desktop-title`](https://github.com/ggbdpq/magpie/tree/hunt30-desktop-title)（基于 7597c132，提交 910522a7）。

<details>
<summary>patch（910522a7）</summary>

```patch
〈format-patch 全文〉
```

</details>

## 没跑什么

- 没跑 GUI 套件（改动不触 GUI）；没在真实 Claude Desktop 上点 Credentials Test（假上游 + 全链路 httptest 覆盖探测形状，探测体按报告的 JSON 构造）。
- 没验证 Desktop 分支名请求（注释说与标题同一 prompt，desktopTitle 一并覆盖；无独立 fixture）。
- internal/gateway 之外的包没跑（改动面 desktop.go/gateway.go 均在 gateway 包内，三平台 vet/build 全仓过）。

合入请保留原作者或加 `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`。

Generated-by: GLM-5.3-Flash (ZCode)
