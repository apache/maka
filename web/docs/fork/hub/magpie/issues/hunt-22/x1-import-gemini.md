# provider: import 链接不认 gemini=，Gemini 兼容中转没法用链接分享（#2201 的兄弟面）

## 现象

应用内编辑器（#2201）、TUI（custom-gemini）和 `magpie provider set`（`gemini=`）都支持只填一个 Gemini URL 的自定义供应商，但 `magpie://import?…` 链接不认 `gemini=`：

- 只带 `gemini=` 的链接被拒绝：`the link gives no base URL: it needs chat=, responses= or anthropic=`——报错本身也没提 gemini；
- `chat=` 和 `gemini=` 同时出现的链接，**gemini= 被静默丢掉**：导入成功的供应商缺了 Gemini 端点，没有任何提示；
- 一个写错的 `gemini=` 值（不是 URL）也被静默忽略，而不是像其它三个参数那样报 `the link's gemini= is not a base URL`。

a430d34e（#2201 的修复）的提交说明里写了「import links (importurl.go) take no gemini= yet, a separate feature」——本单把这件事补齐，让它跟同一提交修好的编辑器行为对齐。

## 最小复现

```
$ magpie import 'magpie://import?name=Gemini%20Relay&gemini=https://relay.example/v1beta&key=sk-g'
magpie import: the link gives no base URL: it needs chat=, responses= or anthropic=
```

修前红测试（`TestParseImportGemini`，在 upstream/main 1ad60446 上）：

```
--- FAIL: TestParseImportGemini (0.00s)
    importurl_test.go:117: the link gives no base URL: it needs chat=, responses= or anthropic=
FAIL
```

## 根因

`internal/provider/importurl.go` 的 `ParseImport`，端点参数是一个写死的 map（约 97 行）：

```go
for k, dst := range map[string]*string{"chat": &p.Chat, "responses": &p.Responses, "anthropic": &p.Anthropic} {
```

`gemini` 不在里面，`get("gemini")` 从未被读；下面「至少一个 base URL」的判断（约 102 行）也只查 `p.Chat == "" && p.Responses == "" && p.Anthropic == ""`。

## 修法

- map 加上 `"gemini": &p.Gemini`，走同一个 `endpoint()` 校验（https / 本机 http、无 query 无 fragment）；
- 「no base URL」的报错补上 `or gemini=`；
- `docs/reference.md` 的 Import links 参数表和 `site/public/docs/import.html`（en、zh）各补一行 `gemini`。

## 验证

| 检查 | 结果 |
| --- | --- |
| `TestParseImportGemini`（gemini 单独；与 chat= 并存；坏的 gemini= 被拒） | 修前红（上面原文），修后绿 |
| `go test -tags nogui -count=1 -run 'TestParseImport' ./internal/provider/` | ok |
| `go test -tags nogui -count=1 ./internal/provider/` | ok（73s） |
| `gofmt -l internal/` | 干净 |
| `go vet` darwin / GOOS=linux -tags nogui / GOOS=windows（provider、cli、gui） | 干净（darwin 仅既有的 trayimage cgo 警告） |
| `go build` darwin / linux nogui / windows | ok |

补丁基于 upstream/main 1ad60446，分支：[ggbdpq/magpie `hunt22-x1-import-gemini`](https://github.com/ggbdpq/magpie/tree/hunt22-x1-import-gemini)（head a9cd9b6e）。如需合入请保留作者署名（`git am` 即可）。

<details>
<summary>patch（git format-patch -1 --stdout）</summary>

```patch
From a9cd9b6e3141910710db70d1027e9d8387791103 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 15 Oct 2026 03:28:52 +0800
Subject: [PATCH] provider: an import link takes a Gemini URL, as the editor,
 the TUI and provider set do

What changed:
- ParseImport reads gemini= like chat=, responses= and anthropic=, so a
  link for a Gemini-compatible relay is imported, and one beside chat=
  keeps the URL instead of losing it silently. A custom provider has been
  added with a Gemini URL alone in the app (#2201) and the TUI, and
  `magpie provider set` takes gemini=; the link was refused with "the
  link gives no base URL: it needs chat=, responses= or anthropic=",
  which names none of what it takes now.
- The parameter tables in docs/reference.md and the import page (en, zh)
  name gemini=.

Run:
- TestParseImportGemini (gemini alone; beside chat=; a bad gemini=
  refused) is red without the importurl.go change ("the link gives no
  base URL: it needs chat=, responses= or anthropic=") and green with it;
  TestParseImport* pass.
- gofmt -l clean; go vet ./internal/provider ./internal/cli ./internal/gui
  on darwin, GOOS=linux -tags nogui and GOOS=windows; go build for the
  three; go test -tags nogui -count=1 ./internal/provider: ok.

Not tried: a real import in the app window (the dialog reads the parsed
provider as it is).

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/reference.md                   |  1 +
 internal/provider/importurl.go      |  8 +++++---
 internal/provider/importurl_test.go | 24 ++++++++++++++++++++++++
 site/public/docs/import.html        |  1 +
 site/public/docs/zh/import.html     |  1 +
 5 files changed, 32 insertions(+), 3 deletions(-)

diff --git a/docs/reference.md b/docs/reference.md
index 55912240..91eadb0f 100644
--- a/docs/reference.md
+++ b/docs/reference.md
@@ -1968,6 +1968,7 @@ you press *Add*. `magpie import <link>` does the same in a terminal.
 | `chat`      | OpenAI Chat Completions base URL (`…/v1`)                          |
 | `responses` | OpenAI Responses base URL (`…/v1`)                                 |
 | `anthropic` | Anthropic Messages base URL (the root, without `/v1`)              |
+| `gemini`    | Google Gemini API base URL (`…/v1beta`), as the app's editor and the TUI take one |
 | `models`    | model ids to expose, comma separated                               |
 | `catalog`   | models.dev provider id, for model names and reasoning levels       |
 | `website`, `keys` | the vendor's site and its API-key page (https)               |
diff --git a/internal/provider/importurl.go b/internal/provider/importurl.go
index 858a48c5..1811bf8b 100644
--- a/internal/provider/importurl.go
+++ b/internal/provider/importurl.go
@@ -25,6 +25,8 @@ import (
 //	chat       OpenAI Chat Completions base URL (…/v1)
 //	responses  OpenAI Responses base URL (…/v1)
 //	anthropic  Anthropic Messages base URL (the root)
+//	gemini     Google Gemini API base URL (…/v1beta), as the app's editor
+//	           and the TUI take one (#1346, #2201)
 //	models     model ids to show agents, comma separated
 //	catalog    models.dev provider id, for names and reasoning levels
 //	website    the vendor's site; keys: where keys are made
@@ -94,13 +96,13 @@ func ParseImport(link string) (Provider, error) {
 		if p.Name == "" {
 			return Provider{}, errors.New("the link names no provider: it needs preset= or name=")
 		}
-		for k, dst := range map[string]*string{"chat": &p.Chat, "responses": &p.Responses, "anthropic": &p.Anthropic} {
+		for k, dst := range map[string]*string{"chat": &p.Chat, "responses": &p.Responses, "anthropic": &p.Anthropic, "gemini": &p.Gemini} {
 			if *dst, err = endpoint(k, get(k)); err != nil {
 				return Provider{}, err
 			}
 		}
-		if p.Chat == "" && p.Responses == "" && p.Anthropic == "" {
-			return Provider{}, errors.New("the link gives no base URL: it needs chat=, responses= or anthropic=")
+		if p.Chat == "" && p.Responses == "" && p.Anthropic == "" && p.Gemini == "" {
+			return Provider{}, errors.New("the link gives no base URL: it needs chat=, responses=, anthropic= or gemini=")
 		}
 		if p.Catalog != "" && p.Catalog != Slug(p.Catalog) {
 			p.Catalog = ""
diff --git a/internal/provider/importurl_test.go b/internal/provider/importurl_test.go
index abc5b5b9..9ef1fda8 100644
--- a/internal/provider/importurl_test.go
+++ b/internal/provider/importurl_test.go
@@ -107,6 +107,30 @@ func TestParseImportRegion(t *testing.T) {
 	}
 }
 
+// A Gemini-compatible relay is added in the app, the TUI and
+// `magpie provider set` with a Gemini URL alone (#1346, #2201); a link
+// naming one was refused as giving no base URL, and a gemini= beside
+// chat= was dropped without a word.
+func TestParseImportGemini(t *testing.T) {
+	p, err := ParseImport("magpie://import?name=Gemini%20Relay&gemini=https://relay.example/v1beta&key=sk-g")
+	if err != nil {
+		t.Fatal(err)
+	}
+	if p.Gemini != "https://relay.example/v1beta" || p.Chat != "" || p.Responses != "" || p.Anthropic != "" {
+		t.Fatalf("gemini only: got %+v", p)
+	}
+	p, err = ParseImport("magpie://import?name=X&chat=https://relay.example/v1/&gemini=https://relay.example/v1beta")
+	if err != nil {
+		t.Fatal(err)
+	}
+	if p.Chat != "https://relay.example/v1" || p.Gemini != "https://relay.example/v1beta" {
+		t.Fatalf("chat and gemini: got %+v", p)
+	}
+	if _, err := ParseImport("magpie://import?name=X&gemini=not-a-url"); err == nil {
+		t.Fatal("a bad gemini= was accepted")
+	}
+}
+
 func TestParseImportRejects(t *testing.T) {
 	for _, link := range []string{
 		"https://usemagpie.ai/import?preset=deepseek",
diff --git a/site/public/docs/import.html b/site/public/docs/import.html
index ecfb8cc0..4af2bd65 100644
--- a/site/public/docs/import.html
+++ b/site/public/docs/import.html
@@ -124,6 +124,7 @@
       <tr><td><code>chat</code></td><td>OpenAI Chat Completions base URL, ending in <code>/v1</code> (magpie appends <code>/chat/completions</code>).</td></tr>
       <tr><td><code>responses</code></td><td>OpenAI Responses base URL, ending in <code>/v1</code>. Codex speaks only this API; magpie translates for it when you don’t.</td></tr>
       <tr><td><code>anthropic</code></td><td>Anthropic Messages base URL: the root, without <code>/v1</code>.</td></tr>
+      <tr><td><code>gemini</code></td><td>Google Gemini API base URL, ending in <code>/v1beta</code>, as the app’s editor and the TUI take one.</td></tr>
       <tr><td><code>key</code></td><td>The user’s API key. Leave it out and the user pastes one in the dialog.</td></tr>
       <tr><td><code>models</code></td><td>Model ids to offer the agents, comma separated. Without it, magpie lists the models your <code>/v1/models</code> returns.</td></tr>
       <tr><td><code>id</code></td><td>The id agents use in <code>id/model</code>. Defaults to the name, lowercased with dashes (<code>Acme Relay</code> → <code>acme-relay</code>).</td></tr>
diff --git a/site/public/docs/zh/import.html b/site/public/docs/zh/import.html
index 73a5a821..594babba 100644
--- a/site/public/docs/zh/import.html
+++ b/site/public/docs/zh/import.html
@@ -124,6 +124,7 @@
       <tr><td><code>chat</code></td><td>OpenAI Chat Completions 的 base URL，以 <code>/v1</code> 结尾（magpie 会自动拼上 <code>/chat/completions</code>）。</td></tr>
       <tr><td><code>responses</code></td><td>OpenAI Responses 的 base URL，以 <code>/v1</code> 结尾。Codex 只支持这个 API；你不支持时，magpie 会替它转换。</td></tr>
       <tr><td><code>anthropic</code></td><td>Anthropic Messages 的 base URL：根地址，不带 <code>/v1</code>。</td></tr>
+      <tr><td><code>gemini</code></td><td>Google Gemini API 的 base URL，以 <code>/v1beta</code> 结尾，和应用内编辑器、TUI 里填的是同一个。</td></tr>
       <tr><td><code>key</code></td><td>用户的 API 密钥。不填的话，用户在对话框里自己粘贴。</td></tr>
       <tr><td><code>models</code></td><td>提供给 Agent 的模型 id，用逗号分隔。不填时，magpie 会列出你的 <code>/v1/models</code> 返回的模型。</td></tr>
       <tr><td><code>id</code></td><td>Agent 在 <code>id/model</code> 里用的 id。默认取名称的小写加连字符形式（<code>Acme Relay</code> → <code>acme-relay</code>）。</td></tr>
-- 
2.50.1 (Apple Git-155)
```

</details>

Generated-by: GLM-5.3-Flash (ZCode)
