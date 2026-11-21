# gateway: 被 accounts 持有的网关 key，在 /v1/models 的 image/video 列表里仍被告知其账号不 serve 的媒体模型

## 现象

- 8b84dc90 让被某些 models 持有的 key 在 `/v1/models` 的 image/video 条目里只看到允许的模型，commit 说 "drop what the key doesn't allow, as the chat list does"。
- 但 chat 列表的过滤（`keyList.entryAllowed`，#905/#474）不止 models 一条：还会因为「该 key 可用的账号/子 key 没有 serve 这个模型」而隐藏。新的 `drawerObjects`/`videomakerObjects` 只做了 `modelAllowed`，没做 `accountServes`——同一文件里 decisions 列表走的 `keyAllowed` 是带 account 限制的（docs/subsystems/providers-accounts.md 也写明 decision 条目 "including model and account restrictions"），三类 kind 条目现在两种口径。
- 结果：一个被持有到某账号（该账号按 #474 只 serve 一个聊天模型）的 key，在 image/video 列表里被告知全部 4 个 grok-imagine 模型；而它真的去画/生成时，account fan-out 会按 #474 把这些模型 barred 掉。列表说能用、请求被拒。

## 最小复现

```
go test -tags nogui -count=1 -run TestGatewayKeyAccountsHoldTheImageAndVideoLists ./internal/gateway
```

设置：grok 已登录（`grokSignedIn` + `newGrokMedia`），key "Held" 被持有到 `grok/me@x.ai`，`SetAccountModels("grok", "me@x.ai", ["grok-4"])`。当前 main（ea3dee96）上的输出：

```
--- FAIL: TestGatewayKeyAccountsHoldTheImageAndVideoLists
    key_models_test.go:446: a key whose account serves the media models not is told of image [grok/grok-imagine-image grok/grok-imagine-image-quality], video [grok/grok-imagine-video grok/grok-imagine-video-1.5]
```

同测试里，本机（无 key）与未被持有到任何账号的 key 都能看到这些模型——这条断言不受影响；只有被持有到账号的 key 泄漏了列表。

## 根因

- `internal/gateway/gateway.go` 的 `drawerObjects` 与 `videomakerObjects`（8b84dc90 引入的 `r *http.Request` 过滤）只有一条判断：
  `if held && !modelAllowed(who, p, m.ID) { continue }`
- chat 列表在 `internal/gateway/key_models.go` 的 `entryAllowed` 是两条：`modelAllowed` 之后再 `k.accountServes(e.Provider, e.Model)`（#905：只在该 key 可用的某账号/子 key serve 该模型时展示；#474 的每账号模型表在 `accountServesOn` 里生效）。key 被持有到 `grok/me@x.ai` 而 `me@x.ai` 的表只有 `grok-4` 时，`AccountServes("me@x.ai", "grok-imagine-image")` 为 false——chat 列表隐藏，媒体列表不隐藏。

## 修法

- 两处判断补上 `accountServes`，与 `entryAllowed` 同口径：
  `if held && (!modelAllowed(who, p, m.ID) || !accountServes(who, p, m.ID)) { continue }`
- 复用现有的 `accountServes(who, p, model)`（key_models.go），media 列表每 provider 只有几条，无需 `keyList` 的缓存。
- 被 models 持有的行为（8b84dc90 的测试）不变：`accountServes` 在 key 未被持有到账号时恒真。

## 验证

| 项目 | 结果 |
| --- | --- |
| 修复前的红测试 | `TestGatewayKeyAccountsHoldTheImageAndVideoLists` 在 7170b5d8 与 ea3dee96 上都失败（输出见上）；把修复从工作树摘掉（`git checkout ea3dee96 -- internal/gateway/gateway.go`）重放，同样红 |
| 修复后 | 该测试 + 8b84dc90 的 `TestGatewayKeyModelsHoldTheImageAndVideoLists` + `TestGatewayKeyAccountsListModels`（chat 列表的 #905/#474 契约）全绿 |
| `go test -tags nogui -p 2 ./internal/gateway` | 整包 ok（285s） |
| `gofmt -l` | 无输出 |
| `go vet` | darwin、`GOOS=linux -tags nogui`、`GOOS=windows` 均通过 |
| `go build` | darwin、`GOOS=linux -tags nogui`、`GOOS=windows` 均通过（darwin 的 `trayimage_darwin.go` -Wenum-conversion 警告与 ld duplicate libraries 警告为已知环境噪音） |
| **没跑的** | 没有用真实 Grok 账号实测远端 magpie 中转的完整链路（`grokSignedIn`/`newGrokMedia` 假件）；没测 #474 之外另一种持有形态（key 名的账号已删除的遗留条目，chat 列表对它有专门测试，媒体列表修复后同样会被 `accountServes` 挡住，但没有单独断言） |

分支：[ggbdpq/magpie@hunt31-c2-prov-keymedia-accounts](https://github.com/ggbdpq/magpie/tree/hunt31-c2-prov-keymedia-accounts)（基于 ea3dee96，测试与修复同一提交）。合入请保留原作者或加 Co-authored-by: ggbdpq <ggbdpq@gmail.com>。

Generated-by: GLM-5.3-Flash (ZCode)

<details><summary>git format-patch</summary>
