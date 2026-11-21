provider: OpenCode 导入只认 19 个 id——zhipuai、zai、alibaba、minimax、kimi-code-plan 等 15 个 magpie 同址 preset 的 key 被误报“没有 base URL”跳过

## 现象

37fec124 把 OpenCode 的 `auth.json` 接进了导入选择器。`openCodePresets`（internal/provider/import_opencode.go）按它自己的注释规则工作——「OpenCode's provider ids by the magpie preset at the same address」——但表里只有 19 个 id。models.dev 目录（OpenCode 的 id 来源）里还有 15 个 id，其 api 主机就是 magpie 某个 preset 的默认地址，全部不在表里，于是在选择器里被列为「it has no base URL」跳过——这对它们是假话：magpie 明明有同址的 preset。

受影响最直接的人群：GLM/Z.ai、Qwen/DashScope、MiniMax、ModelScope、Kimi Code、StepFun、火山方舟、百炼/腾讯云 Token Plan、Kilo、ClinePass 的 OpenCode 用户——恰好是 magpie preset 覆盖最全的那批厂商。例如用 `opencode auth login` 登过 Zhipu GLM（id `zhipuai`）的用户，在导入选择器里看到的是一行「跳过：它没有 base URL」，只能手工重建 provider。

## 最小复现

`auth.json` 放一个 api 型条目（`XDG_DATA_HOME` 沙盒指向临时目录）：

```json
{ "zhipuai": { "type": "api", "key": "sk-zhipu-oc" } }
```

新测试 `TestImportOpenCodeVendorPresets`（15 个 id 逐个断言「落到同名 preset、无 skip」）在 37fec124 上全红：

```
--- FAIL: TestImportOpenCodeVendorPresets (0.00s)
    import_opencode_test.go:251: alibaba: skipped: it has no base URL
    import_opencode_test.go:251: alibaba-cn: skipped: it has no base URL
    import_opencode_test.go:251: cline-pass: skipped: it has no base URL
    import_opencode_test.go:251: kilo: skipped: it has no base URL
    import_opencode_test.go:251: kimi-code-plan-cn: skipped: it has no base URL
    import_opencode_test.go:251: kimi-code-plan-global: skipped: it has no base URL
    import_opencode_test.go:251: minimax: skipped: it has no base URL
    import_opencode_test.go:251: modelscope: skipped: it has no base URL
    import_opencode_test.go:251: stepfun-ai-step-plan: skipped: it has no base URL
    import_opencode_test.go:251: stepfun-step-plan: skipped: it has no base URL
    import_opencode_test.go:251: volcengine-coding-plan: skipped: it has no base URL
    import_opencode_test.go:251: zai: skipped: it has no base URL
    import_opencode_test.go:251: zhipuai: skipped: it has no base URL
    ...（alibaba-token-plan-cn、tencent-token-plan 同形，共 15 行）
```

## 根因

`openCodePresets`（internal/provider/import_opencode.go:34）漏了满足自己声明规则的 id。逐条对照 models.dev 的 `api` 字段（OpenCode 实际发往的地址，auth.json 只存 key 不存地址）与 magpie preset 的默认端点：

| OpenCode id | models.dev api | magpie preset（默认端点） |
| --- | --- | --- |
| zhipuai | open.bigmodel.cn/api/paas/v4 | zhipu（同一 URL） |
| zai | api.z.ai/api/paas/v4 | zai（同一 URL） |
| alibaba | dashscope-intl.aliyuncs.com/compatible-mode/v1 | qwen（同一 URL） |
| alibaba-cn | dashscope.aliyuncs.com/compatible-mode/v1 | qwen-cn（同一 URL） |
| minimax | api.minimax.io | minimax（api.minimax.io/v1 + /anthropic） |
| modelscope | api-inference.modelscope.cn/v1 | modelscope（同一 URL） |
| kilo | api.kilo.ai | kilo（api.kilo.ai/api/openrouter） |
| cline-pass | api.cline.bot/api/v1 | clinepass（同一 URL） |
| kimi-code-plan-cn | api.kimi.com/coding/v1 | kimi-code-cn（同一 URL） |
| kimi-code-plan-global | api.kimi.ai/coding/v1 | kimi-code（同一 URL） |
| stepfun-step-plan | api.stepfun.com/step_plan/v1 | stepfun-cn（同一 URL） |
| stepfun-ai-step-plan | api.stepfun.ai/step_plan/v1 | stepfun（同一 URL） |
| volcengine-coding-plan | ark.cn-beijing.volces.com/api/coding/v3 | volcengine（同一 URL） |
| alibaba-token-plan-cn | token-plan.cn-beijing.maas.aliyuncs.com | bailian-token-plan（同主机） |
| tencent-token-plan | api.lkeap.cloud.tencent.com | tencent-cloud（/plan/v3，同主机） |

对照规则的两个既有先例：已收录的 `opencode → opencode-zen` 也是主机级同址（models.dev 的 api 是 opencode.ai/inference/v1，preset 是 opencode.ai/zen/v1，路径不同）；commit 说明里 SiliconFlow 的 `.com` id 被排除是因为它对应 preset 的 intl **region**，而 auth.json 没有可用来选 region 的信息——上表 15 条不含任何 region 型匹配，preset 默认端点即该 id 的产品本体（Kimi Code/Step Plan/方舟 Coding Plan/两个 Token Plan 的 preset 默认端点本来就是其 plan 端点）。

## 修法

补齐 15 条映射，一行一个（patch 见下）。仍然排除、并在 commit message 里写明理由的：

- **需要选 region、auth.json 无从选起**（同 SiliconFlow `.com` 先例）：`zhipuai-coding-plan`、`zai-coding-plan`（各自 preset 的 plan region）、`minimax-coding-plan`、`stepfun`/`stepfun-ai`/`volcengine`（按量付费 id 落在 plan 优先的默认端点上）、`tencent-coding-plan`；
- **已迁社区插件的订阅**：`xiaomi-token-plan-*`（mimo-app）；
- 主机是 `localhost` 的 `privatemode-ai` 无对应本体。

## 验证

| 项 | 结果 |
| --- | --- |
| TestImportOpenCodeVendorPresets（新，15 id 表驱动） | 37fec124 上红：15 行 `skipped: it has no base URL`；补映射后绿 |
| 消融复核 | `git stash -- internal/provider/import_opencode.go` 后重跑：15 行同形红；pop 后绿 |
| TestImportOpenCodeAuth / AuthWithoutXDG / AuthUnknown（既有夹具） | 绿，`len(items) != 7` 等既有断言未动 |
| go test -tags nogui -count=1 ./internal/provider（全包） | ok |
| gofmt -l internal/ | 干净 |
| go vet（darwin -tags nogui、GOOS=linux -tags nogui、GOOS=windows） | 干净 |
| go build darwin / GOOS=linux -tags nogui / GOOS=windows | ok |

models.dev 数据取自 2026-10-15 抓取的 <https://models.dev/api.json>（230 个 provider，id 与 api 字段逐条核对）。

## 没跑什么

- GUI playwright（import-opencode.test.cjs 等）：本 patch 不触 GUI 代码与任何 i18n 字符串，夹具里的既有行不变；新 id 的行渲染与既有 vendor 行同一代码路径。
- 真机 OpenCode：15 个 id 的 key 未逐一在对应厂商真实服务上验证连通（导入只是把 key 放到 preset 的既有端点上，端点本身是 magpie 既有测过的）；zhipuai/zai 落在按量付费默认端点，plan key 走 1113 → RetryZhipuCoding 的既有自愈路径，未实测。
- Windows 桌面端手工验证（路径逻辑与 37fec124 相同，未改动）。

## 补丁与分支

- fork 分支：<https://github.com/ggbdpq/magpie/tree/hunt24-a-opencode-presets>（36c7d330，基 upstream/main 4a6bf80f）
- 请求保留作者署名（git am 可直接应用）。

<details>
<summary>patch（git format-patch -1 --stdout）</summary>

```patch
From 36c7d33048fe1d3a9fa23854f2c933b2d49c4ed3 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 15 Oct 2026 20:55:30 +0800
Subject: [PATCH] import: OpenCode's ids for the vendors magpie has presets for
 come in on them
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

openCodePresets held 19 of models.dev's ids. 15 more name a provider whose
preset serves the very host models.dev gives as the id's api — Zhipu, Z.ai,
Qwen and Qwen China (Alibaba's dashscope ids), MiniMax, ModelScope, Kilo,
ClinePass, both Kimi Code plans, both Step Plans, Volcengine's Coding Plan,
Bailian's and Tencent Cloud's Token Plans — and were listed and skipped as
"it has no base URL", which is not true of them: magpie has the preset at
that address. Each now comes in on its preset, the way openai's or
deepseek's key does.

Left out, where a region would be the target and auth.json says nothing to
pick it by: zhipuai-coding-plan and zai-coding-plan (the plan regions),
minimax-coding-plan, the pay-as-you-go ids of plan-first presets (stepfun,
stepfun-ai, volcengine), tencent-coding-plan, and the ids of subscriptions
magpie moved to plugins (the Xiaomi MiMo token plans).

Run (macOS arm64, go1.26.8, worktree at 37fec124):
- TestImportOpenCodeVendorPresets, new: red before (15 items, each
  "skipped: it has no base URL"), green with the map filled; red again
  with import_opencode.go stashed, green on pop.
- go test -tags nogui -count=1 ./internal/provider: ok.
- gofmt -l internal: clean. go vet -tags nogui ./internal/provider,
  GOOS=linux -tags nogui, GOOS=windows: clean.
- go build, GOOS=linux -tags nogui, GOOS=windows: ok.
---
 internal/provider/import_opencode.go      | 12 +++++
 internal/provider/import_opencode_test.go | 59 +++++++++++++++++++++++
 2 files changed, 71 insertions(+)

diff --git a/internal/provider/import_opencode.go b/internal/provider/import_opencode.go
index 24a71c96..1b2173d4 100644
--- a/internal/provider/import_opencode.go
+++ b/internal/provider/import_opencode.go
@@ -31,6 +31,12 @@ func openCodeAuthPath() string {
 // openCodePresets are OpenCode's provider ids by the magpie preset at the
 // same address. An id at a host the preset doesn't serve (SiliconFlow's
 // .com beside the preset's .cn) is left out: its key would be sent there.
+// The ids' hosts are models.dev's api for each, what OpenCode itself sends
+// to, and it is the preset's own address, not one of its regions. Where a
+// region would be the right target — Zhipu's, Z.ai's, StepFun's and
+// Volcengine's pay-as-you-go ids beside plan-first defaults, MiniMax's and
+// Tencent's coding plans — auth.json says nothing to pick a region by, so
+// those ids stay out and are skipped with a reason that says why.
 var openCodePresets = map[string]string{
 	"opencode": "opencode-zen", "opencode-go": "opencode-go",
 	"openai": "openai", "anthropic": "anthropic", "google": "google", "deepseek": "deepseek",
@@ -38,6 +44,12 @@ var openCodePresets = map[string]string{
 	"groq": "groq", "openrouter": "openrouter", "togetherai": "together", "fireworks-ai": "fireworks",
 	"siliconflow-cn": "siliconflow", "nvidia": "nvidia", "aihubmix": "aihubmix", "302ai": "302ai",
 	"ollama-cloud": "ollama-cloud",
+	"zhipuai":      "zhipu", "zai": "zai", "alibaba": "qwen", "alibaba-cn": "qwen-cn",
+	"minimax": "minimax", "modelscope": "modelscope", "kilo": "kilo", "cline-pass": "clinepass",
+	"kimi-code-plan-cn": "kimi-code-cn", "kimi-code-plan-global": "kimi-code",
+	"stepfun-step-plan": "stepfun-cn", "stepfun-ai-step-plan": "stepfun",
+	"volcengine-coding-plan": "volcengine",
+	"alibaba-token-plan-cn":  "bailian-token-plan", "tencent-token-plan": "tencent-cloud",
 }
 
 func readOpenCodeAuth(path string) ([]AppImport, error) {
diff --git a/internal/provider/import_opencode_test.go b/internal/provider/import_opencode_test.go
index 3a3d2aef..e8c11939 100644
--- a/internal/provider/import_opencode_test.go
+++ b/internal/provider/import_opencode_test.go
@@ -1,9 +1,12 @@
 package provider
 
 import (
+	"fmt"
+	"maps"
 	"os"
 	"path/filepath"
 	"runtime"
+	"slices"
 	"testing"
 	"time"
 )
@@ -203,3 +206,59 @@ func TestImportOpenCodeAuthUnknown(t *testing.T) {
 		t.Fatalf("unreadable folder: %+v", s)
 	}
 }
+
+// A vendor's key whose OpenCode id is a provider magpie has a preset for
+// comes in on that preset: the id's host in models.dev's catalog is the
+// preset's own address. Each entry here is api, so a key lands on the
+// preset with no skip, the way openai's or deepseek's does.
+func TestImportOpenCodeVendorPresets(t *testing.T) {
+	home := openCodeHome(t)
+	data := filepath.Join(home, "data")
+	t.Setenv("XDG_DATA_HOME", data)
+	want := map[string]string{
+		"zhipuai":                "zhipu",
+		"zai":                    "zai",
+		"alibaba":                "qwen",
+		"alibaba-cn":             "qwen-cn",
+		"minimax":                "minimax",
+		"modelscope":             "modelscope",
+		"kilo":                   "kilo",
+		"cline-pass":             "clinepass",
+		"kimi-code-plan-cn":      "kimi-code-cn",
+		"kimi-code-plan-global":  "kimi-code",
+		"stepfun-step-plan":      "stepfun-cn",
+		"stepfun-ai-step-plan":   "stepfun",
+		"volcengine-coding-plan": "volcengine",
+		"alibaba-token-plan-cn":  "bailian-token-plan",
+		"tencent-token-plan":     "tencent-cloud",
+	}
+	entries := ""
+	for id := range want {
+		entries += fmt.Sprintf(",\n  %q: {\"type\": \"api\", \"key\": \"sk-oc-%s\"}", id, id)
+	}
+	p := filepath.Join(data, "opencode", "auth.json")
+	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
+		t.Fatal(err)
+	}
+	if err := os.WriteFile(p, []byte("{"+entries[1:]+"\n}"), 0o600); err != nil {
+		t.Fatal(err)
+	}
+	items := itemsOf(t, "opencode")
+	if len(items) != len(want) {
+		t.Fatalf("items: %d, want %d", len(items), len(want))
+	}
+	for _, id := range slices.Sorted(maps.Keys(want)) {
+		it := items[id]
+		if it.Skip != "" {
+			t.Errorf("%s: skipped: %s", id, it.Skip)
+			continue
+		}
+		pr := Preset(want[id])
+		if pr == nil {
+			t.Fatalf("preset %s: none", want[id])
+		}
+		if it.Provider.Preset != pr.ID || it.Provider.Name != pr.Name || it.Provider.Chat != pr.Chat || it.Provider.Key != "sk-oc-"+id {
+			t.Errorf("%s: got %+v, want the %s preset", id, it.Provider, pr.ID)
+		}
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>

Generated-by: GLM-5.3-Flash (ZCode)
