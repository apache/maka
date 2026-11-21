provider: magpie 接管 Claude Code 时打开导入，stash 换回只恢复 3 个键——tier/subagent 模型（claude.env.*）被丢掉

## 现象

magpie 接管 Claude Code 时（`internal/agent/claude.go`），用户 settings.json 里原来的 endpoint、token、主模型和 tier/subagent 模型一起存进 `stash.json`（`claude.base_url`、`claude.auth_token`、`claude.model`，加 `claude.env.<VAR>` 前缀的其余键），注释明言「back with it when magpie steps out」。Disconnect 时这些键全部放回；但**导入读侧**（`readClaudeSettings`，provider 一侧的另一个 stash 消费者）只恢复 3 个键，`claude.env.*` 全部丢弃：

- 用户 settings.json 指向 gateway 时打开导入（窗口的 signin/import 或 `magpie accounts import`），Claude Code 来源条目的 models 列表只有主模型（如 `claude-sonnet-5`），丢了接管前用户配的 `ANTHROPIC_DEFAULT_SONNET_MODEL`、`ANTHROPIC_DEFAULT_OPUS/HAIKU/FABLE_MODEL`、`ANTHROPIC_SMALL_FAST_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL`——正是「这个 relay 还服务哪些模型」的证据， Disconnect 会还回来的那六把。

写读不对等：写侧把 3+15 个键存进同一个 stash，读侧只认 3 个。

## 最小复现

测试 `TestClaudeImportWhileRoutedTakesTheStashedEnv`（patch 内），在修复前 upstream/main（422d057d）上跑：

```
--- FAIL: TestClaudeImportWhileRoutedTakesTheStashedEnv (0.91s)
    importapps_test.go:555: models [claude-sonnet-5] miss claude-sonnet-5-x
```

手工路径：MAGPIE_ADDR 指向一个端口，settings.json 的 `env.ANTHROPIC_BASE_URL` 写成 `http://127.0.0.1:<该端口>`（接管形态）；stash.json 存 `claude.base_url=https://relay.example.com/anthropic`、`claude.model=claude-sonnet-5`、`claude.env.ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-5-x`；打开导入——Claude Code 条目的模型清单没有 `claude-sonnet-5-x`。

## 根因

- internal/provider/importapps.go:531 — `readClaudeSettings` 检测到 settings.json 指向 magpie 自身后，`env` 被整体替换为仅含 `st["claude.base_url"]`、`st["claude.auth_token"]`、`st["claude.model"]` 的三键 map；stash 里 `claude.env.<VAR>` 键（接管时由 internal/agent/claude.go:1384-1392 写入的 tier/subagent 模型）没有任何读取路径。
- 下游 internal/provider/importapps.go:691（`ccSwitchEntry` 的 claude 分支）按 `ANTHROPIC_MODEL` 与四个 `ANTHROPIC_DEFAULT_*_MODEL`、`ANTHROPIC_SMALL_FAST_MODEL` 收集 models——env 里没有，列表就短。

## 修法

替换 env 时把 stash 的 `claude.env.` 前缀键一并并入（消费侧自挑认识的键，多出的 `_NAME`/`_DESCRIPTION` 等描述键无害）：

```go
env = map[string]any{"ANTHROPIC_BASE_URL": st["claude.base_url"], "ANTHROPIC_AUTH_TOKEN": st["claude.auth_token"], "ANTHROPIC_MODEL": st["claude.model"]}
for k, v := range st {
    if name, ok := strings.CutPrefix(k, "claude.env."); ok && v != "" {
        env[name] = v
    }
}
```

键名前缀 `claude.env.` 与既有硬编码（`claude.base_url` 等）同源，均指本机 agent 的裸键（WSL twin 的键带 place 前缀，而 `readClaudeSettings` 只读本机 settings.json，不涉及其它 place）。env 只在导入读内部消费，不写回任何文件。

## 验证

| 检查 | 结果 |
| --- | --- |
| `go test -tags nogui -run TestClaudeImportWhileRoutedTakesTheStashedEnv ./internal/provider/`（修复前 422d057d） | 红：`models [claude-sonnet-5] miss claude-sonnet-5-x` |
| 同上（修复后 28d41b9a） | 绿 |
| 消融：`git checkout 28d41b9a~1 -- internal/provider/importapps.go` 后重放 | 红同形，恢复修复即绿 |
| 定向回归 `TestClaudeConfigDirImport`、`TestImport*`、`TestAdd*` | 绿 |
| `gofmt -l internal/provider/` | 干净 |
| `go vet` darwin(nogui) / linux(nogui) / windows | 全绿 |
| `go build` darwin / linux(nogui) / windows | 全绿 |
| patch 序列在 422d057d 上 `git am` | 两枚干净应用 |

没跑什么：GUI 套件；未在真实接管环境端到端实测（测试按接管路径的写侧键名构造 stash，键名对照 internal/agent/claude.go:1383-1392）；trayimage cgo 与 ld 警告为已知环境噪音。

patch（两枚：第一枚是 [#2427](https://github.com/yetone/magpie/issues/2427) 已发的 Gemini host 匹配修复，因两枚都动 importapps_test.go 的相邻位置而一并附上使序列可 `git am`；第二枚是本单，commit 28d41b9a）：

<details><summary>patch</summary>

```
From a65d714036837797ef732460045ebf09a3172297 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 15 Oct 2026 23:22:11 +0800
Subject: [PATCH 1/2] provider: a provider's Gemini URL counts as its host when
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


From 28d41b9a45ff163ffcc54fb67467a47f92ec7e36 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 15 Oct 2026 23:33:49 +0800
Subject: [PATCH 2/2] provider: reading Claude Code's settings while routed
 takes the stashed tier models with it
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: when Claude Code's settings.json points at the gateway,
readClaudeSettings swaps in what routing stashed. It took the endpoint,
token and main model but left the claude.env.<VAR> keys behind — the
tier models (ANTHROPIC_DEFAULT_*_MODEL), ANTHROPIC_SMALL_FAST_MODEL and
CLAUDE_CODE_SUBAGENT_MODEL that routing set aside with them
(internal/agent/claude.go, "back with it when magpie steps out"). The
import entry then offered only the main model where stepping out would
have restored six more. The claude.env.* keys now come back with the
three, as Disconnect would put them.

Run: go test -tags nogui -run
'TestClaudeImportWhileRoutedTakesTheStashedEnv|TestClaudeConfigDirImport|TestImport'
./internal/provider/ green; the new test red on the parent (models
[claude-sonnet-5] miss claude-sonnet-5-x); gofmt -l clean; go vet and
build green on darwin (nogui), linux (nogui) and windows. Not run: the
GUI suite; trayimage cgo and ld warnings on darwin are known noise.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/importapps.go      |  9 ++++++
 internal/provider/importapps_test.go | 47 ++++++++++++++++++++++++++++
 2 files changed, 56 insertions(+)

diff --git a/internal/provider/importapps.go b/internal/provider/importapps.go
index 98edc60f..11fcf0d8 100644
--- a/internal/provider/importapps.go
+++ b/internal/provider/importapps.go
@@ -528,7 +528,16 @@ func readClaudeSettings(path string) ([]AppImport, error) {
 			if b, err := os.ReadFile(filepath.Join(filepath.Dir(Path()), "stash.json")); err == nil {
 				json.Unmarshal(b, &st)
 			}
+			// what routing put aside is what stepping out would put back:
+			// the endpoint, token and main model, and with them the
+			// models of the user's own the tiers and subagents ran on
+			// (claude.env.<VAR>, internal/agent/claude.go)
 			env = map[string]any{"ANTHROPIC_BASE_URL": st["claude.base_url"], "ANTHROPIC_AUTH_TOKEN": st["claude.auth_token"], "ANTHROPIC_MODEL": st["claude.model"]}
+			for k, v := range st {
+				if name, ok := strings.CutPrefix(k, "claude.env."); ok && v != "" {
+					env[name] = v
+				}
+			}
 		}
 	}
 	base, _ := env["ANTHROPIC_BASE_URL"].(string)
diff --git a/internal/provider/importapps_test.go b/internal/provider/importapps_test.go
index b656c209..c7623846 100644
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
@@ -509,3 +510,49 @@ func TestGeminiURLIsItsHost(t *testing.T) {
 		t.Fatalf("the relay's import entry: %+v", it)
 	}
 }
+
+// While magpie routes Claude Code, its settings.json points at the
+// gateway and what the user had there stands by in the stash. The import
+// reads the stash back as magpie stepping out would put it back: the
+// tier and subagent models beside the endpoint, token and main model.
+func TestClaudeImportWhileRoutedTakesTheStashedEnv(t *testing.T) {
+	isolate(t)
+	home := t.TempDir()
+	t.Setenv("HOME", home)
+	t.Setenv("USERPROFILE", home)
+	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming"))
+	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
+	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
+	t.Setenv("MAGPIE_ADDR", "127.0.0.1:49999")
+	path := claudeSettingsPath()
+	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
+		t.Fatal(err)
+	}
+	// routed: magpie wrote its own address and key over the user's relay
+	if err := os.WriteFile(path, []byte(`{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:49999","ANTHROPIC_AUTH_TOKEN":"sk-magpie"}}`), 0o600); err != nil {
+		t.Fatal(err)
+	}
+	if err := os.MkdirAll(filepath.Dir(Path()), 0o700); err != nil {
+		t.Fatal(err)
+	}
+	stash := map[string]string{
+		"claude.base_url":   "https://relay.example.com/anthropic",
+		"claude.auth_token": "sk-claude",
+		"claude.model":      "claude-sonnet-5",
+		"claude.env.ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-5-x",
+		"claude.env.ANTHROPIC_SMALL_FAST_MODEL":     "claude-haiku-x",
+	}
+	b, _ := json.Marshal(stash)
+	if err := os.WriteFile(filepath.Join(filepath.Dir(Path()), "stash.json"), b, 0o600); err != nil {
+		t.Fatal(err)
+	}
+	it := itemsOf(t, "claude-code")["settings"]
+	if it.Skip != "" || it.Provider.Key != "sk-claude" {
+		t.Fatalf("the relay in the stash: %+v", it)
+	}
+	for _, m := range []string{"claude-sonnet-5", "claude-sonnet-5-x", "claude-haiku-x"} {
+		if !slices.Contains(it.Provider.Models, m) {
+			t.Fatalf("models %v miss %s", it.Provider.Models, m)
+		}
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>

分支：https://github.com/ggbdpq/magpie/tree/hunt26-prov-claude-stash-env

合入请保留原作者或加 Co-authored-by: ggbdpq <ggbdpq@gmail.com>

Generated-by: GLM-5.3-Flash (ZCode)
