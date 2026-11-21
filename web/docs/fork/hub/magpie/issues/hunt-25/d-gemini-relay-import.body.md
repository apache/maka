## 现象

CC Switch 里 Gemini CLI 的中转条目（`env` 带 `GOOGLE_GEMINI_BASE_URL` + `GEMINI_API_KEY`）在导入选择器里被列为跳过：「magpie doesn't talk the Gemini protocol to relays yet」（zh：「magpie 暂不支持以 Gemini 协议连接中转」）。Alma 的 `format: "gemini"` 或 `type: google` 且带 `base_url` 的条目同款跳过。这条跳过的理由已经不成立：#1346 之后自定义 provider 带 Gemini 端点，编辑器、TUI、`magpie://import` 链接（#2201、#2251）都收 Gemini base，magpie 会把请求翻成 Gemini 的 generateContent 发去中转。用户现在只能绕开导入、照着中转文档手工重建 provider。

## 最小复现

`TestImportCCSwitch`（internal/provider/importapps_test.go）的 fixture 里本就有这样一行。把该行的断言从「必须 skip」翻成「按 Gemini 端点提供」（本 patch 所为），在 2e2c8903 的产品文件上跑：

```
--- FAIL: TestImportCCSwitch (0.45s)
    importapps_test.go:81: gemini relay: {Ref:gemini/g From:Gemini CLI Provider:{... Chat: Responses: Anthropic: Gemini: ...} Status: Existing: KeyOf: Reserved:false Off: Skip:magpie doesn't talk the Gemini protocol to relays yet}
FAIL
```

消融同形：`git checkout 2e2c8903 -- internal/provider/importapps.go internal/provider/import_opencode.go` 后重跑，同一句红（0.28s）。

## 根因

internal/provider/importapps.go 的 `ccSwitchEntry`：

```go
case "gemini":
    key = str(env, "GEMINI_API_KEY", "GOOGLE_API_KEY")
    if str(env, "GOOGLE_GEMINI_BASE_URL") != "" {
        return name, "", eps, nil, "magpie doesn't talk the Gemini protocol to relays yet"
    }
```

和 `readAlma` 的 switch：

```go
case format == "gemini" || typ == "google" && base != "":
    skip = "magpie doesn't talk the Gemini protocol to relays yet"
```

两处的拒绝都写在 0b0f258c0（import from other apps 引入时，magpie 确实不说 Gemini 协议），#1346 落地后没有跟着回改。`endpoints` 结构体只有 chat/responses/anthropic 三个字段，没有地方放 Gemini base。

## 修法

- `endpoints` 加 `gemini` 字段；`imported()` 对它做与另外三个端点相同的检查（http/https、非 magpie 自身地址）并写进 `Provider.Gemini`；`merge()` 合并同 key 条目时带上它；`firstURL()` 认它。
- CC Switch 的 `case "gemini"`：有 `GOOGLE_GEMINI_BASE_URL` 就落 `eps.gemini`（key 与 `GEMINI_MODEL` 照旧读取）；没有时行为不变（google preset 的 OpenAI 端点，无 key 仍是 sign-in 跳过）。
- Alma 的同款 case 落 `eps.gemini`。
- `presetAt` 仍只按 chat/responses/anthropic 匹配，Gemini-only 条目保持自定义 provider；落盘时 `Save` 的 `GeminiBase` 归一化（补 /v1beta），与 import 链接的 `gemini=` 一致。
- 删除这条 skip 和它在 i18n.js 的 4 条翻译（zh、zh-TW、ja、de），别无使用处。

## 验证

| 步骤 | 结果 |
| --- | --- |
| 修前红（2e2c8903 产品文件 + 新断言） | `TestImportCCSwitch` FAIL，Skip 原文，Provider 全空（0.45s） |
| 消融：`git checkout 2e2c8903 -- importapps.go import_opencode.go` 回红 | 同句 FAIL（0.28s） |
| 修复后定向测试（CCSwitch/Alma/FromApps/OpenCode） | ok（1.119s） |
| `go test -tags nogui -count=1 ./internal/provider ./internal/usage ./internal/catalog` | 3 包 ok（74s/11s/2s） |
| `gofmt -l internal/` | 干净 |
| `go vet -tags nogui`（darwin / GOOS=linux / GOOS=windows） | 干净（trayimage_darwin.go 的 cgo -Wenum-conversion 警告为已知环境噪音） |
| `go build`（darwin / GOOS=linux -tags nogui / GOOS=windows） | ok |

改动了现有断言：`TestImportCCSwitch` 原来断言 gemini/g 条目「必须跳过」，现在断言它按 Gemini 端点提供。可能被维护者否掉的条件：若认为 Gemini 协议翻译对中转（非 Google 官方端点）还不够完整、想继续挡导入，这条就该保留——但 #2201/#2251 已把另外两个入口打开，且 OpenCode Go/Zen 的 Gemini 模型（#2168）也走这条路在线上跑。

## 没跑什么

- 没有真实 CC Switch/Alma 安装：fixture 用的是两库的导出格式（CC Switch 的 sqlite `settings_config`、Alma 的 `providers` 表），与读取器解析的键一致，但没在真实数据库上点过导入。
- 没起真实 Gemini 协议中转验证网关到 `p.Gemini` 端点的回合；#1346 的既有测试覆盖该翻译路径，本单只打通「条目 → Provider.Gemini」。
- GUI 的 Playwright 套件没跑（改动只删了 4 条 i18n 死翻译，未触 app.js）。

<details><summary>patch</summary>

```
PLACEHOLDER_PATCH
```

</details>

分支：https://github.com/ggbdpq/magpie/tree/hunt25-prov-gemini-relay-import

合入请保留原作者或加 Co-authored-by: ggbdpq <ggbdpq@gmail.com>

Generated-by: GLM-5.3-Flash (ZCode)
