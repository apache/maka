The takeover's beside wiring took the top-level `model_provider` down silently, and Codex went on listing the config without it — every thread saved with the provider it names stopped resuming with `modelProviderMismatch`, exactly as reported here. Reproduced it from your description: a config with `model_provider = "custom"` at the top and the provider's own table, a ChatGPT sign-in, one magpie model picked — the line was gone and `openai_base_url` was in its place, while the `[model_providers.custom]` table stayed.

Root cause: the beside wiring in `internal/agent/codex.go` (`set`, the path that points the built-in OpenAI provider at magpie's gateway instead of naming magpie) deletes the top-level `model_provider` and `model_catalog_json` unconditionally, whatever value the top-level line holds. The `Join` path right next to it already refuses to touch a provider of the user's (`p != "" && p != "openai" && !isCCSwitchMirror(p)` returns early), so the two paths disagreed. Codex checks a resumed thread's saved provider against the provider its config is on now — with the line gone that reads as built-in `openai`, and any thread started under the user's provider fails with "This chat uses custom, but your current provider is openai".

What changed: the beside wiring now steps beside only from a provider magpie puts back itself — its own at the top, none, or CC Switch's mirror of OpenAI, the same set `Join` has always had. Over a provider of the user's, the takeover goes by the provider instead: it names magpie (`model_provider = "magpie"`) and keeps the user's spelling in magpie's stash, so Disconnect/Unwire puts `model_provider = "custom"` back, as any takeover does. A reset (`Fields[0].Set("")`) leaves the line where the user put it too — it takes magpie's keys out, not theirs — so a Codex a reset sends back to its own config goes on resuming the threads it saved under the user's provider. Sibling sites checked: the other three `DelTOMLTop` calls on `model_provider` all run behind an `asProvider()` guard or `Join`'s refusal, so they only ever delete magpie's own value; `putProvider` writes only the `[model_providers.magpie]` table and never the top-level line. Already-lost lines are not brought back by this: where the stash is gone, the value from your backup (`model_provider = "custom"`) is the one to paste back, as in your workaround.

| Check | Result |
| --- | --- |
| `TestCodexTakeoverKeepsUserProvider` (new) | fails on parent `c0477aa72`, passes here |
| `TestCodexResetKeepsUserProvider` (new) | fails on parent, passes here |
| Ablation (product files reverted to parent, tests kept) | both tests red on parent, green with the fix |
| `go test -tags nogui ./internal/agent/` | passes except `TestMothX`, which fails the same way on the untouched parent `c0477aa72` (pre-existing, unrelated to codex) |
| `gofmt -l`, `go vet -tags nogui` (changed package, darwin) | clean |
| `GOOS=linux go vet`, `GOOS=windows go vet` | clean |
| `go build -tags nogui` darwin / linux / windows | all pass |

Not verified: against a real Codex app resume of a session saved under CC Switch's `custom` provider (needs CC Switch and a ChatGPT account here) — the fix keeps the config's top-level line intact, which is the state your workaround re-creates by hand; and the `isCCSwitchMirror` exemption stays as `Join` has it, so a top-level provider that *is* CC Switch's official OpenAI mirror is still stepped beside, same as before this patch.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: fix(agent/codex): keep the user's model_provider over a takeover or reset (#4347) — git am applies it as is; SHA-256 first 16: c0306e50baac60b4</summary>

```patch
From e2445d7d1b600ea83c6089f7bbf11c87b6681ba7 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 1 Nov 2026 21:26:36 +0800
Subject: [PATCH] fix(agent/codex): keep the user's model_provider over a
 takeover or reset (#4347)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: the beside wiring of a Codex takeover took the top-level
model_provider down silently whenever a magpie model was picked beside
the ChatGPT sign-in — a provider of the user's (CC Switch's custom, an
older takeover's) went with it, and every Codex thread saved with that
provider stopped resuming (modelProviderMismatch: Codex falls back to
its built-in openai, the threads name the provider they were started
on, #4347). The wiring now steps beside only from a provider magpie
puts back itself (its own, none, CC Switch's mirror of OpenAI, as Join
already has it); over a provider of the user's the takeover names
magpie instead and keeps the user's spelling in the stash, for Unwire
to put back, as any takeover does. A reset leaves the line where the
user put it too: it takes magpie's keys out, not theirs.

Run: go test -tags nogui -run 'TestCodexTakeoverKeepsUserProvider|TestCodexResetKeepsUserProvider' ./internal/agent/ (both fail on the parent, pass here); go test -tags nogui ./internal/agent/ passes.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/agent/codex.go                    | 27 ++++++++++--
 internal/agent/codex_user_provider_test.go | 51 ++++++++++++++++++++++
 2 files changed, 75 insertions(+), 3 deletions(-)
 create mode 100644 internal/agent/codex_user_provider_test.go

diff --git a/internal/agent/codex.go b/internal/agent/codex.go
index 02c8ac6a4..86d60c992 100644
--- a/internal/agent/codex.go
+++ b/internal/agent/codex.go
@@ -1342,7 +1342,15 @@ func codexIn(at place) *Agent {
 			if err := dropBase(); err != nil {
 				return err
 			}
-			if err := edit.DelTOMLTop(path, "model", "model_provider", "model_catalog_json"); err != nil {
+			// Codex as installed: OpenAI, its own catalog, its default
+			// model. A provider of the user's at the top stays (#4347):
+			// a reset takes magpie's keys out, not theirs, and Codex
+			// goes on resuming the threads it saved with theirs
+			keys := []string{"model", "model_catalog_json"}
+			if p := get("model_provider"); p == "" || p == "openai" || p == magpieID {
+				keys = append(keys, "model_provider")
+			}
+			if err := edit.DelTOMLTop(path, keys...); err != nil {
 				return err
 			}
 			dropList()
@@ -1374,8 +1382,18 @@ func codexIn(at place) *Agent {
 			// that. Wired so for that alone, it is marked (codex.out), for
 			// Sync to put it back beside the sign-in once the account has
 			// room again.
+			// Beside the sign-in only from a provider at the top that is
+			// magpie's to take down: its own, none, or CC Switch's mirror
+			// of OpenAI, as Join has it. A provider of the user's (CC
+			// Switch's custom, an older takeover's) is not taken down
+			// silently (#4347): every thread saved with it stopped
+			// resuming (modelProviderMismatch). The takeover names magpie
+			// and keeps the user's spelling in the stash, for Unwire to
+			// put back.
+			p := get("model_provider")
+			ours := asProvider() || p == "" || p == "openai" || isCCSwitchMirror(p)
 			chatgpt := !api() && chatGPT()
-			if chatgpt && !out() {
+			if chatgpt && !out() && ours {
 				forget(at.key("codex.out"))
 				if err := dropProvider(); err != nil {
 					return err
@@ -1401,7 +1419,10 @@ func codexIn(at place) *Agent {
 				}
 				return settle()
 			}
-			if chatgpt {
+			// codex.out is for an account the takeover stands in for: a
+			// provider of the user's taken over is magpie's doing, not
+			// the account's, so Sync never steps Codex out of it
+			if chatgpt && ours {
 				stash(map[string]string{at.key("codex.out"): "1"})
 			} else {
 				forget(at.key("codex.out"))
diff --git a/internal/agent/codex_user_provider_test.go b/internal/agent/codex_user_provider_test.go
new file mode 100644
index 000000000..329bed98d
--- /dev/null
+++ b/internal/agent/codex_user_provider_test.go
@@ -0,0 +1,51 @@
+package agent
+
+import (
+	"strings"
+	"testing"
+)
+
+// A Codex of the user's own provider (CC Switch's custom, an older
+// takeover's): model_provider at the top and its table. Picking a magpie
+// model beside the ChatGPT sign-in took the line down silently, and every
+// thread saved with the user's provider stopped resuming
+// (modelProviderMismatch, #4347). magpie goes by the provider instead,
+// the user's spelling kept in the stash, and stepping out puts it back.
+func TestCodexTakeoverKeepsUserProvider(t *testing.T) {
+	home, read := codexHome(t, chatGPTAuth,
+		"model = \"gpt-5.5\"\nmodel_provider = \"custom\"\n\n[model_providers.custom]\nname = \"Custom\"\nbase_url = \"http://127.0.0.1:9/v1\"\nwire_api = \"responses\"\n")
+	cx := codex(home)
+	if err := cx.Fields[0].Set("fake/m1"); err != nil {
+		t.Fatal(err)
+	}
+	cfg := read()
+	if !strings.Contains(cfg, `model_provider = "magpie"`) || !strings.Contains(cfg, `model = "fake/m1"`) ||
+		!strings.Contains(cfg, "[model_providers.custom]") || !strings.Contains(cfg, "[model_providers.magpie]") {
+		t.Fatalf("a magpie model over the user's provider:\n%s", cfg)
+	}
+	// and stepping out puts the user's provider back
+	if err := cx.Disconnect(); err != nil {
+		t.Fatal(err)
+	}
+	if cfg = read(); !strings.Contains(cfg, `model_provider = "custom"`) || strings.Contains(cfg, "openai_base_url") {
+		t.Fatalf("disconnected, the user's provider not put back:\n%s", cfg)
+	}
+}
+
+// A reset takes magpie's keys out, not the user's: a provider of the
+// user's at the top stays, and Codex goes on resuming the threads it
+// saved with (#4347).
+func TestCodexResetKeepsUserProvider(t *testing.T) {
+	home, read := codexHome(t, "",
+		"model = \"fake/m1\"\nmodel_provider = \"custom\"\nmodel_catalog_json = \"/x/list.json\"\n\n[model_providers.custom]\nname = \"Custom\"\nbase_url = \"http://127.0.0.1:9/v1\"\nwire_api = \"responses\"\n")
+	cx := codex(home)
+	if err := cx.Fields[0].Set(""); err != nil {
+		t.Fatal(err)
+	}
+	cfg := read()
+	if !strings.Contains(cfg, `model_provider = "custom"`) || !strings.Contains(cfg, "[model_providers.custom]") ||
+		strings.Contains(cfg, "model_catalog_json") || strings.Contains(cfg, `[model = "fake/m1"]`) {
+		t.Fatalf("reset over the user's provider:\n%s", cfg)
+	}
+	_ = home
+}
-- 
2.50.1 (Apple Git-155)
```

</details>

Branch with the commit: [fix/4347-takeover-keep-model-provider](https://github.com/ggbdpq/magpie/tree/fix/4347-takeover-keep-model-provider) (head `e2445d7d1b600ea83c6089f7bbf11c87b6681ba7`).
