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
From a4b0ecbb44328a9a19f928348ab516e780de9859 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 15 Oct 2026 22:00:21 +0800
Subject: [PATCH] import: a Gemini-protocol relay's key comes in on the
 provider's Gemini endpoint

CC Switch's and Alma's entries whose base speaks Gemini's own protocol
(GOOGLE_GEMINI_BASE_URL, Alma's gemini format or a google type with a
base_url) were listed and skipped as "magpie doesn't talk the Gemini
protocol to relays yet". That was true when the import was written
(0b0f258c0), but magpie has spoken the protocol since #1346: a custom
provider takes a Gemini base, as the editor, the TUI (#2201) and import
links (#2251) do. A Gemini CLI user whose relay set GOOGLE_GEMINI_BASE_URL
could not import the key at all, only rebuild the provider by hand.

endpoints carries the Gemini base now, and imported() checks and keeps it
as it does the other three: valid http(s), never magpie's own address,
merged beside them when one key serves several apps' entries. The skip,
its four translations, and both readers' refusals go.

What doesn't change: an entry with no base still comes in on Google's
preset (its OpenAI endpoint), a sign-in with no key is still skipped, and
a base is still asked for a key. presetAt still matches on chat,
responses and anthropic alone, so a Gemini-only entry stays a custom
provider; Save normalizes its base (GeminiBase) as an import link's
gemini= is.

Run:
- TestImportCCSwitch, its gemini row flipped from "must skip" to "comes
  in on the Gemini endpoint with its key and GEMINI_MODEL": red before
  ("gemini relay: ... Skip:magpie doesn't talk the Gemini protocol to
  relays yet"), green after; red again with importapps.go and
  import_opencode.go checked out at the parent.
- go test -tags nogui -count=1 ./internal/provider ./internal/usage
  ./internal/catalog: ok.
- gofmt -l internal: clean. go vet -tags nogui ./..., GOOS=linux -tags
  nogui, GOOS=windows: clean. Builds darwin, linux (nogui), windows: ok.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gui/assets/i18n.js          |  4 ---
 internal/provider/import_opencode.go |  2 +-
 internal/provider/importapps.go      | 38 ++++++++++++++++------------
 internal/provider/importapps_test.go | 10 +++++---
 4 files changed, 30 insertions(+), 24 deletions(-)

diff --git a/internal/gui/assets/i18n.js b/internal/gui/assets/i18n.js
index b8150562..32a0bc0a 100644
--- a/internal/gui/assets/i18n.js
+++ b/internal/gui/assets/i18n.js
@@ -1716,7 +1716,6 @@ const I18N = {
     "it is the agent's own sign-in; add the subscription in magpie": "这是 agent 自己的登录，请在 magpie 里添加订阅",
     "it is the agent's own sign-in": "这是 agent 自己的登录",
     "it is a sign-in, not a key; add the subscription in magpie": "这是登录账号而不是密钥，请在 magpie 里添加订阅",
-    "magpie doesn't talk the Gemini protocol to relays yet": "magpie 暂不支持以 Gemini 协议连接中转",
     "it has no Azure OpenAI endpoint": "没有 Azure OpenAI 终结点",
     "it points at magpie itself": "它指向的就是 magpie 自己",
     "it has no base URL": "没有 Base URL",
@@ -5288,7 +5287,6 @@ const I18N = {
     "it is the agent's own sign-in; add the subscription in magpie": "這是 agent 自己的登入，請在 magpie 裡新增訂閱",
     "it is the agent's own sign-in": "這是 agent 自己的登入",
     "it is a sign-in, not a key; add the subscription in magpie": "這是登入帳號而不是金鑰，請在 magpie 裡新增訂閱",
-    "magpie doesn't talk the Gemini protocol to relays yet": "magpie 暫不支援以 Gemini 協議連線中轉",
     "it has no Azure OpenAI endpoint": "沒有 Azure OpenAI 端點",
     "it points at magpie itself": "它指向的就是 magpie 自己",
     "it has no base URL": "沒有 Base URL",
@@ -8839,7 +8837,6 @@ const I18N = {
     "it is the agent's own sign-in; add the subscription in magpie": "エージェント自身のサインインです。magpie でサブスクリプションを追加してください",
     "it is the agent's own sign-in": "エージェント自身のサインインです",
     "it is a sign-in, not a key; add the subscription in magpie": "キーではなくサインインです。magpie でサブスクリプションを追加してください",
-    "magpie doesn't talk the Gemini protocol to relays yet": "magpie はまだ中継サービスと Gemini プロトコルで通信できません",
     "it has no Azure OpenAI endpoint": "Azure OpenAI のエンドポイントがありません",
     "it points at magpie itself": "magpie 自身を指しています",
     "it has no base URL": "ベース URL がありません",
@@ -12416,7 +12413,6 @@ const I18N = {
     "it is the agent's own sign-in; add the subscription in magpie": "es ist die eigene Anmeldung des Agenten; fügen Sie das Abo in magpie hinzu",
     "it is the agent's own sign-in": "es ist die eigene Anmeldung des Agenten",
     "it is a sign-in, not a key; add the subscription in magpie": "es ist eine Anmeldung, kein Schlüssel; fügen Sie das Abo in magpie hinzu",
-    "magpie doesn't talk the Gemini protocol to relays yet": "magpie spricht mit Relays noch nicht das Gemini-Protokoll",
     "it has no Azure OpenAI endpoint": "es hat keinen Azure-OpenAI-Endpunkt",
     "it points at magpie itself": "es zeigt auf magpie selbst",
     "it has no base URL": "es hat keine Basis-URL",
diff --git a/internal/provider/import_opencode.go b/internal/provider/import_opencode.go
index 24a71c96..c3ff93c7 100644
--- a/internal/provider/import_opencode.go
+++ b/internal/provider/import_opencode.go
@@ -75,7 +75,7 @@ func readOpenCodeAuth(path string) ([]AppImport, error) {
 		case strings.TrimSpace(e.Key) == "":
 			skip = "it has no API key"
 		default:
-			it.Provider, skip = imported(name, strings.TrimSpace(e.Key), endpoints{pr.Chat, pr.Responses, pr.Anthropic}, nil)
+			it.Provider, skip = imported(name, strings.TrimSpace(e.Key), endpoints{pr.Chat, pr.Responses, pr.Anthropic, ""}, nil)
 		}
 		if skip != "" {
 			it.Provider, it.Skip = Provider{Name: name}, skip
diff --git a/internal/provider/importapps.go b/internal/provider/importapps.go
index 13dc7070..b15a51cb 100644
--- a/internal/provider/importapps.go
+++ b/internal/provider/importapps.go
@@ -354,15 +354,15 @@ func hostOf(raw string) string {
 }
 
 // endpoints are the base URLs an entry names, by protocol.
-type endpoints struct{ chat, responses, anthropic string }
+type endpoints struct{ chat, responses, anthropic, gemini string }
 
 // imported builds the provider for an entry: a preset's when the entry
 // points at one magpie knows (its endpoints whole when the URL is the
 // preset's own, only its name and logo when it is another path on the same
 // host, like a coding plan), a custom one otherwise.
 func imported(name, key string, e endpoints, models []string) (Provider, string) {
-	e.chat, e.responses, e.anthropic = cleanBase(e.chat), cleanBase(e.responses), cleanBase(e.anthropic)
-	for _, u := range []string{e.chat, e.responses, e.anthropic} {
+	e.chat, e.responses, e.anthropic, e.gemini = cleanBase(e.chat), cleanBase(e.responses), cleanBase(e.anthropic), cleanBase(e.gemini)
+	for _, u := range []string{e.chat, e.responses, e.anthropic, e.gemini} {
 		if u == "" {
 			continue
 		}
@@ -374,10 +374,10 @@ func imported(name, key string, e endpoints, models []string) (Provider, string)
 			return Provider{}, "it points at magpie itself"
 		}
 	}
-	if e.chat == "" && e.responses == "" && e.anthropic == "" {
+	if e.chat == "" && e.responses == "" && e.anthropic == "" && e.gemini == "" {
 		return Provider{}, "it has no base URL"
 	}
-	p := Provider{ID: Slug(name), Name: name, Key: key, Chat: e.chat, Responses: e.responses, Anthropic: e.anthropic, Models: models}
+	p := Provider{ID: Slug(name), Name: name, Key: key, Chat: e.chat, Responses: e.responses, Anthropic: e.anthropic, Gemini: e.gemini, Models: models}
 	if p.IsAzure() {
 		// an Azure OpenAI resource, from any app: the preset's, its
 		// endpoints on the resource's v1 API
@@ -642,7 +642,7 @@ func merge(have []AppImport, it AppImport) []AppImport {
 		if have[i].Skip != "" || h.Key != it.Provider.Key || h.Key == "" || !sameProvider(*h, it.Provider) && hostOf(firstURL(*h)) != hostOf(firstURL(it.Provider)) {
 			continue
 		}
-		for _, f := range []struct{ dst, src *string }{{&h.Chat, &it.Provider.Chat}, {&h.Responses, &it.Provider.Responses}, {&h.Anthropic, &it.Provider.Anthropic}} {
+		for _, f := range []struct{ dst, src *string }{{&h.Chat, &it.Provider.Chat}, {&h.Responses, &it.Provider.Responses}, {&h.Anthropic, &it.Provider.Anthropic}, {&h.Gemini, &it.Provider.Gemini}} {
 			if *f.dst == "" {
 				*f.dst = *f.src
 			}
@@ -655,7 +655,7 @@ func merge(have []AppImport, it AppImport) []AppImport {
 }
 
 func firstURL(p Provider) string {
-	for _, u := range []string{p.Chat, p.Responses, p.Anthropic} {
+	for _, u := range []string{p.Chat, p.Responses, p.Anthropic, p.Gemini} {
 		if u != "" {
 			return u
 		}
@@ -721,14 +721,18 @@ func ccSwitchEntry(e ccEntry) (name, key string, eps endpoints, models []string,
 		}
 	case "gemini":
 		key = str(env, "GEMINI_API_KEY", "GOOGLE_API_KEY")
-		if str(env, "GOOGLE_GEMINI_BASE_URL") != "" {
-			return name, "", eps, nil, "magpie doesn't talk the Gemini protocol to relays yet"
-		}
-		if key == "" {
-			return name, "", eps, nil, "it is the agent's own sign-in"
+		// a relay that speaks Gemini's own protocol (#1346): its base is
+		// the provider's Gemini endpoint, as the editor, the TUI and an
+		// import link take one
+		if base := str(env, "GOOGLE_GEMINI_BASE_URL"); base != "" {
+			eps.gemini = base
+		} else {
+			if key == "" {
+				return name, "", eps, nil, "it is the agent's own sign-in"
+			}
+			pr := Preset("google")
+			eps.chat, eps.responses, eps.anthropic = pr.Chat, pr.Responses, pr.Anthropic
 		}
-		pr := Preset("google")
-		eps.chat, eps.responses, eps.anthropic = pr.Chat, pr.Responses, pr.Anthropic
 		if m := str(env, "GEMINI_MODEL"); m != "" {
 			models = append(models, m)
 		}
@@ -875,11 +879,13 @@ func readAlma(path string) ([]AppImport, error) {
 			}
 		case base == "" && Preset(almaPresets[typ]) != nil:
 			pr := Preset(almaPresets[typ])
-			eps = endpoints{pr.Chat, pr.Responses, pr.Anthropic}
+			eps = endpoints{pr.Chat, pr.Responses, pr.Anthropic, ""}
 		case format == "anthropic" || typ == "anthropic":
 			eps.anthropic = base
 		case format == "gemini" || typ == "google" && base != "":
-			skip = "magpie doesn't talk the Gemini protocol to relays yet"
+			// a relay that speaks Gemini's own protocol (#1346): its base
+			// is the provider's Gemini endpoint
+			eps.gemini = base
 		case responses || format == "openai-responses":
 			eps.responses = base
 		default:
diff --git a/internal/provider/importapps_test.go b/internal/provider/importapps_test.go
index c34f024e..449e9b86 100644
--- a/internal/provider/importapps_test.go
+++ b/internal/provider/importapps_test.go
@@ -5,6 +5,7 @@ import (
 	"encoding/json"
 	"os"
 	"path/filepath"
+	"slices"
 	"strings"
 	"testing"
 )
@@ -59,7 +60,7 @@ func TestImportCCSwitch(t *testing.T) {
 		`INSERT INTO providers VALUES ('relay','codex','Some Relay','{"auth":{"OPENAI_API_KEY":"sk-relay"},"config":"model_provider = \"relay\"\nmodel = \"gpt-5.5\"\n\n[model_providers.relay]\nname = \"relay\"\nbase_url = \"https://relay.example.com/v1\"\nwire_api = \"responses\"\n"}','','custom',3,0)`,
 		`INSERT INTO providers VALUES ('ds','claude','DeepSeek','{"env":{"ANTHROPIC_BASE_URL":"https://api.deepseek.com/anthropic","ANTHROPIC_AUTH_TOKEN":"sk-ds"}}','','cn_official',4,2)`,
 		`INSERT INTO providers VALUES ('dial','pi','dial','{"api":"openai-completions","apiKey":"magpie","baseUrl":"http://127.0.0.1:3425/v1"}','','custom',5,0)`,
-		`INSERT INTO providers VALUES ('g','gemini','Gemini relay','{"env":{"GOOGLE_GEMINI_BASE_URL":"https://g.example.com","GEMINI_API_KEY":"k"}}','','custom',6,0)`,
+		`INSERT INTO providers VALUES ('g','gemini','Gemini relay','{"env":{"GOOGLE_GEMINI_BASE_URL":"https://g.example.com","GEMINI_API_KEY":"k","GEMINI_MODEL":"gemini-3.8-flash"}}','','custom',6,0)`,
 	)
 	// DeepSeek is already here under its preset id, with another key
 	if err := Save(FromPresetKey(t, "deepseek", "sk-other")); err != nil {
@@ -73,8 +74,11 @@ func TestImportCCSwitch(t *testing.T) {
 	if it := items["pi/dial"]; it.Skip == "" {
 		t.Fatalf("magpie itself offered: %+v", it)
 	}
-	if it := items["gemini/g"]; it.Skip == "" {
-		t.Fatalf("gemini relay offered: %+v", it)
+	g := items["gemini/g"]
+	// a Gemini-protocol relay (#1346): the base goes to the provider's own
+	// Gemini endpoint, as the editor, the TUI and import links take one
+	if g.Skip != "" || g.Provider.Gemini != "https://g.example.com" || g.Provider.Key != "k" || !slices.Equal(g.Provider.Models, []string{"gemini-3.8-flash"}) {
+		t.Fatalf("gemini relay: %+v", g)
 	}
 	relay := items["claude/relay"]
 	if relay.Skip != "" || relay.Status != "new" || relay.Provider.Anthropic != "https://relay.example.com" || relay.Provider.Responses != "https://relay.example.com/v1" || relay.From != "Claude Code, Codex" {
-- 
2.50.1 (Apple Git-155)


```

</details>

分支：https://github.com/ggbdpq/magpie/tree/hunt25-prov-gemini-relay-import

合入请保留原作者或加 Co-authored-by: ggbdpq <ggbdpq@gmail.com>

Generated-by: GLM-5.3-Flash (ZCode)
