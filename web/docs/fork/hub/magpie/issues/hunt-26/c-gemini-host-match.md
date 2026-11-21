provider: 一把 key 的 Gemini 协议中转添加两次不报「已添加」——sameProvider 的 host 名单漏了 Gemini URL

## 现象

magpie 从 #1346 起支持自定义供应商的 Gemini 协议 URL（`gemini=`，编辑器与 TUI 都可填）。但「同一把 key 在同一个 host 上就是同一个账号」的判定 `sameProvider`（internal/provider/importapps.go）收集 host 时只看 `Chat / Responses / Anthropic / Decide`，唯独没有 `Gemini`。后果：

1. **编辑器/CLI 添加重复不拦**：`Add` 的重复检查（internal/provider/provider.go:909，注释明言「adding it twice would only split its usage」）对 Gemini-only 供应商永不命中——同一中转同一把 key 添加第二次直接落成 `gemini-relay-2`，用量从此劈成两份，正是该检查要防的事。
2. **导入判重失效**：从 CC Switch / Alma / Claude Code settings 导入时，`settle` 的 `same`/`keyOf` 判定（internal/provider/importapps.go:285、292）认不出 magpie 已有同 key 的 Gemini 中转——同一 relay 在 magpie 里以 Gemini URL 存在、导入条目以 chat/anthropic 协议指向同一 host 同一 key 时被标为 `new`，用户勾选后重复添加（`holds` 同样放行）。

`a` 侧名单里有后来加的 `Decide`（决策 API），却没有更早的 `Gemini`——加 Decide 时同步了名单，#1346 加 Gemini URL 时没有回头补，典型的名单漂移。

## 最小复现

测试 `TestGeminiURLIsItsHost`（patch 内，internal/provider/importapps_test.go），在修复前 upstream/main（422d057d）上跑：

```
--- FAIL: TestGeminiURLIsItsHost (0.52s)
    importapps_test.go:500: the same relay was added again as "gemini-relay-2"
```

手工路径：Providers 页添加一个只填 Gemini URL（如 `https://g.example.com`）+ key 的供应商；再原样添加一次——第二次被接受为 `…-2`，而不是报「is already added with that key」。

## 根因

- internal/provider/importapps.go:335 — `sameProvider` 的 a 侧 host 收集列表 `[]string{a.Chat, a.Responses, a.Anthropic, a.Decide}` 缺 `a.Gemini`；
- internal/provider/importapps.go:340 — b 侧遍历 `[]string{b.Chat, b.Responses, b.Anthropic}` 同样缺 `b.Gemini`（#2413 的 Gemini 协议导入落地后，导入条目也会带 Gemini URL，此侧不补则新路径照样漏）；
- internal/provider/importapps.go:170、292 — 两处用 `Provider{Key:…, Chat: h.Chat, Responses:…, Anthropic:…, Headers:…}` 重建 magpie 已有供应商做比对，没带 `h.Gemini`，已有供应商的 Gemini host 进不了比对。

## 修法

最小改动，不碰任何在途 patch 的行（`merge`/`firstURL` 留给 #2413，不冲突）：

- 两个列表各加入 Gemini；
- 两处重建处补 `Gemini: h.Gemini`。

行为不变式：只有当供应商真的填了 Gemini URL 时判定才变化；无 Gemini URL 的供应商路径与原来逐字节相同。

## 验证

| 检查 | 结果 |
| --- | --- |
| `go test -tags nogui -run TestGeminiURLIsItsHost ./internal/provider/`（修复前 422d057d） | 红：`the same relay was added again as "gemini-relay-2"` |
| 同上（修复后 a65d7140） | 绿 |
| 消融：`git checkout a65d7140~1 -- internal/provider/importapps.go` 后重放 | 红同形，恢复修复即绿 |
| 定向回归 `TestImport*|TestAdd*` 等 | 绿 |
| 全包 `go test -tags nogui -p 2 ./internal/provider/ ./internal/usage/ ./internal/catalog/` | 全绿（provider 72.7s / usage 12.4s / catalog 0.9s） |
| `gofmt -l internal/provider/` | 干净 |
| `go vet` darwin(nogui) / linux(nogui) / windows | 全绿 |
| `go build` darwin / linux(nogui) / windows | 全绿 |

没跑什么：GUI 套件（本改动不触 GUI 资产）；未对真实 CC Switch/Alma 数据库实测（用同构 sqlite fixture）；darwin 构建的 trayimage cgo `-Wenum-conversion` 与 ld duplicate-library 警告为已知环境噪音。

patch（基于 upstream/main 422d057d，commit a65d7140）：

<details><summary>patch</summary>

```
From a65d714036837797ef732460045ebf09a3172297 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 15 Oct 2026 23:22:11 +0800
Subject: [PATCH] provider: a provider's Gemini URL counts as its host when
 import and Add match the same account
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: sameProvider collected a provider's hosts from Chat,
Responses, Anthropic and Decide but not Gemini, so a Gemini-protocol
relay (#1346) was known to no comparison by its Gemini URL: adding the
same relay and key again from the editor went through Add's duplicate
check as a new provider (gemini-relay-2, its usage split — the exact
split the check exists to prevent), and an import entry at the relay
over another protocol read "new" instead of "same". The Gemini URL now
joins both lists, and the two places that rebuild the provider magpie
has (the key-join check in ImportFromApps, keyOf in settle) carry
h.Gemini so the same holding works from the other side.

Run: go test -tags nogui -run 'TestGeminiURLIsItsHost|TestImport|TestAdd'
./internal/provider/ green; the new test red on the parent
(same relay added again as "gemini-relay-2"); gofmt -l clean; go vet and
build green on darwin (nogui), linux (nogui) and windows. Not run: the
GUI suite; the trayimage cgo -Wenum-conversion and ld duplicate-library
warnings on darwin are known noise.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/importapps.go      |  8 +++----
 internal/provider/importapps_test.go | 31 ++++++++++++++++++++++++++++
 2 files changed, 35 insertions(+), 4 deletions(-)

diff --git a/internal/provider/importapps.go b/internal/provider/importapps.go
index 8dcd2cdd..98edc60f 100644
--- a/internal/provider/importapps.go
+++ b/internal/provider/importapps.go
@@ -167,7 +167,7 @@ func ImportFromApps(picks []AppPick) ([]string, error) {
 			}
 			// a key joins a provider only at its own address: one taken
 			// to another host would be sent there
-			if h.Account != nil || !sameProvider(Provider{Key: p.Key, Chat: h.Chat, Responses: h.Responses, Anthropic: h.Anthropic, Headers: h.Headers}, p) {
+			if h.Account != nil || !sameProvider(Provider{Key: p.Key, Chat: h.Chat, Responses: h.Responses, Anthropic: h.Anthropic, Gemini: h.Gemini, Headers: h.Headers}, p) {
 				return added, errorf("%s: %s isn't at %s; add it as a provider of its own", p.Name, h.Name, hostOf(firstURL(p)))
 			}
 			if err := AddKey(it.KeyOf, p.Name, p.Key, ""); err != nil {
@@ -290,7 +290,7 @@ func settle(items []AppImport, have []Provider, used map[string]bool) []AppImpor
 				it.Status, it.Existing = "taken", h.Name
 			}
 			if it.KeyOf == "" && h.Key != "" && sameProvider(Provider{
-				Key: p.Key, Chat: h.Chat, Responses: h.Responses, Anthropic: h.Anthropic, Headers: h.Headers,
+				Key: p.Key, Chat: h.Chat, Responses: h.Responses, Anthropic: h.Anthropic, Gemini: h.Gemini, Headers: h.Headers,
 			}, *p) {
 				it.KeyOf = h.ID
 			}
@@ -332,12 +332,12 @@ func sameProvider(a, b Provider) bool {
 		return false
 	}
 	hosts := map[string]bool{}
-	for _, u := range []string{a.Chat, a.Responses, a.Anthropic, a.Decide} {
+	for _, u := range []string{a.Chat, a.Responses, a.Anthropic, a.Gemini, a.Decide} {
 		if h := hostOf(u); h != "" {
 			hosts[h] = true
 		}
 	}
-	for _, u := range []string{b.Chat, b.Responses, b.Anthropic} {
+	for _, u := range []string{b.Chat, b.Responses, b.Anthropic, b.Gemini} {
 		if hosts[hostOf(u)] {
 			return true
 		}
diff --git a/internal/provider/importapps_test.go b/internal/provider/importapps_test.go
index c34f024e..b656c209 100644
--- a/internal/provider/importapps_test.go
+++ b/internal/provider/importapps_test.go
@@ -478,3 +478,34 @@ func TestImportCCSwitchConfigWithBOM(t *testing.T) {
 		t.Fatalf("config.json with a BOM: %+v %v", items, err)
 	}
 }
+
+// A provider's Gemini URL (#1346) names its host like its other endpoints
+// do: the same key at that host is the provider already here, not another
+// one to add beside it.
+func TestGeminiURLIsItsHost(t *testing.T) {
+	isolate(t)
+	home := t.TempDir()
+	t.Setenv("HOME", home)
+	t.Setenv("USERPROFILE", home)
+	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
+	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
+
+	// a Gemini-protocol relay added from the editor is known by its
+	// Gemini URL: the same key there again is the one already here
+	first := Provider{Name: "Gemini Relay", Key: "sk-g", Gemini: "https://g.example.com"}
+	if _, err := Add(first); err != nil {
+		t.Fatal(err)
+	}
+	if id, err := Add(Provider{Name: "Gemini Relay", Key: "sk-g", Gemini: "https://g.example.com"}); err == nil {
+		t.Fatalf("the same relay was added again as %q", id)
+	}
+
+	// an import entry at the relay over another protocol is the provider
+	// already here at its Gemini URL, the same key in hand
+	it := settle([]AppImport{{Ref: "r", Provider: Provider{
+		ID: "gr", Name: "Gemini Relay", Key: "sk-g", Chat: "https://g.example.com/v1",
+	}}}, All(), map[string]bool{})[0]
+	if it.Status != "same" || it.Existing != "Gemini Relay" {
+		t.Fatalf("the relay's import entry: %+v", it)
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>

分支：https://github.com/ggbdpq/magpie/tree/hunt26-prov-gemini-host-match

合入请保留原作者或加 Co-authored-by: ggbdpq <ggbdpq@gmail.com>

Generated-by: GLM-5.3-Flash (ZCode)
