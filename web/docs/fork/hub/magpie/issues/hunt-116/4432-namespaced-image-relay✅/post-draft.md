The face loscoy's retest left is the one the narrowing doesn't cover: the relay's cached list names the family's members under a namespace (`openai/gpt-image-1`, `openai/gpt-image-2` and the rest, all Draws), and `drawsFamily`'s relay branch reads its own list by the bare `gpt-image-` prefix (`strings.HasPrefix(m.ID, codexDrawerFamily)`), so a list full of namespaced ids reads as drawing none — the relay that draws is passed over as a chat-only one, and the bare `gpt-image-2` a Codex harness asks its provider for gets the 404, on v0.1.2670, after 7e44e57b4 and a130035a0.

**Reproduced offline** with the reporter's shape — a keyed Responses relay whose list carries only `openai/gpt-image-*` names:

- `TestRelayDrawsTheGPTImageFamilyFromANamespacedList` — bare `gpt-image-2` on the images API answers `404 magpie knows no model "gpt-image-2" to draw with`, the reporter's error verbatim;
- `TestCodexNativeDrawsItsOwnModelOnANamespacedRelay` — the built-in image tool on a Codex turn whose provider holds the namespaced list answers **200 with the Settings' pick** (`relay/openai/gpt-image-2.5-flare`) where the harness asked for `gpt-image-2`.

**Fix**: the relay's drawers are read by the name past the namespace — the part of the id after its last `/`, the id itself when its list carries none (one added index into the check a130035a0 already has). The narrowing stands as it was: only a relay whose own list draws a GPT Image takes the family (`TestRelayDrawingNoGPTImageClaimsNoneOfTheFamily` stays green), and the bare name goes upstream as asked, the vendor refusing in its own words one it doesn't serve — `magpie_image` with the whole namespaced id resolves by exact id as it did (that path doesn't run through `drawsFamily`). The same check serves the images API, Codex's turn provider, and `drawsFamily`'s other callers; chat hot paths are untouched.

**Verification** (base `18c69aa46`, head `0632ba416`, tree `/tmp/mg-r14-e` on the pushed branch):

| Check | Result |
| --- | --- |
| Red without the fix (both new tests, product reverted to base semantics) | `--- FAIL: TestRelayDrawsTheGPTImageFamilyFromANamespacedList` 404 verbatim; `--- FAIL: TestCodexNativeDrawsItsOwnModelOnANamespacedRelay` 200 with `relay/openai/gpt-image-2.5-flare` |
| Green with the fix | both pass; directed `Draw|Drawing|Relay` ok (re-run on the rebased head) |
| Ablation (only `internal/gateway/draw.go` reverted, tests kept) | both red again, recover on restore |
| `go test ./internal/gateway/... -tags nogui -count=1` | one fail: `TestCodexPoolSaysTheClientsVersion` — known suite flake on this machine, passes alone |
| `-race` on the directed run | ok |
| `gofmt -l`, `go vet -tags nogui` (darwin/linux/windows), `go build -tags nogui` (darwin/linux/windows) | clean / all ok / all ok |

**Not verified**: a real relay whose list is namespaced (the offline relay stands in for loscoy's), and whether that relay's images API serves the bare `gpt-image-2` the patch forwards — magpie hands the request over as asked and tells the vendor's own refusal if it doesn't.

---
**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>.`

**Patch**: <details><summary>patch: fix(gateway): a relay's namespaced list still draws the gpt-image family (#4432) — git am applies it as is; SHA-256 first 16: eed7b554de60a102</summary>

```patch
From 0632ba41695c16cb770c327165f69dd19b9b0fcf Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 2 Nov 2026 19:47:48 +0800
Subject: [PATCH] fix(gateway): a relay's namespaced list still draws the
 gpt-image family (#4432)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

loscoy's retest (v0.1.2670) still answered 404 "magpie knows no model
"gpt-image-2" to draw with" for the bare name a Codex harness asks its
provider for: the relay's list magpie had cached names the family's
members under a namespace (openai/gpt-image-1, openai/gpt-image-2 and
the rest, all Draws), and the check a130035a0 narrowed the family to —
a drawer whose id has the gpt-image- prefix — read those ids as none of
the family, so the relay that draws was passed over as a chat-only one.
The bare name's own Codex turn lost the drawing to the Settings' pick
the same way (TestCodexNativeDrawsItsOwnModelOnANamespacedRelay).

The family is the name past the namespace: the relay's drawers are read
by the part of the id after its last "/" (the bare one when the list
carries none). The narrowing stands as it was: only a relay whose list
draws a GPT Image takes the family, and the bare name goes upstream as
asked, the vendor refusing in its own words one it doesn't serve.

Fixes #4432
Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/draw.go                 | 15 ++++---
 internal/gateway/drawing_resolve_test.go | 57 ++++++++++++++++++++++++
 2 files changed, 66 insertions(+), 6 deletions(-)

diff --git a/internal/gateway/draw.go b/internal/gateway/draw.go
index 00e76f606..33a0b15cd 100644
--- a/internal/gateway/draw.go
+++ b/internal/gateway/draw.go
@@ -177,11 +177,12 @@ func resolveDrawing(id string) (provider.Provider, string, bool) {
 // are of: any grok-imagine-image* on a Grok subscription, any gpt-image-*
 // on a ChatGPT account, and any gpt-image-* on a keyed relay at a Responses
 // base (a Codex backend relay such as sub2api) whose own list draws one of
-// that family already (#4432). The vendor's newer ones work before magpie
-// names them, as grok-imagine-video* do for videos; one it doesn't serve is
-// refused by the vendor, in its own words. A relay whose list draws no
-// GPT Image isn't taken to: a Codex turn on it draws with the Settings
-// pick, as it did (TestCodexDrawingFallsBackToImageSetting).
+// that family already (#4432), by the name past the namespace its list may
+// carry (openai/gpt-image-2, loscoy's). The vendor's newer ones work before
+// magpie names them, as grok-imagine-video* do for videos; one it doesn't
+// serve is refused by the vendor, in its own words. A relay whose list
+// draws no GPT Image isn't taken to: a Codex turn on it draws with the
+// Settings pick, as it did (TestCodexDrawingFallsBackToImageSetting).
 func drawsFamily(p provider.Provider, id string) bool {
 	switch {
 	case drawsGrok(p):
@@ -189,7 +190,9 @@ func drawsFamily(p provider.Provider, id string) bool {
 	case drawsCodex(p):
 		return strings.HasPrefix(id, codexDrawerFamily)
 	case p.Account == nil && p.Base(provider.Responses) != "" && strings.HasPrefix(id, codexDrawerFamily):
-		return slices.ContainsFunc(Drawers(p), func(m catalog.Model) bool { return strings.HasPrefix(m.ID, codexDrawerFamily) })
+		return slices.ContainsFunc(Drawers(p), func(m catalog.Model) bool {
+			return strings.HasPrefix(m.ID[strings.LastIndexByte(m.ID, '/')+1:], codexDrawerFamily)
+		})
 	}
 	return false
 }
diff --git a/internal/gateway/drawing_resolve_test.go b/internal/gateway/drawing_resolve_test.go
index a81d31828..d4f42798e 100644
--- a/internal/gateway/drawing_resolve_test.go
+++ b/internal/gateway/drawing_resolve_test.go
@@ -174,6 +174,63 @@ func TestRelayDrawingNoGPTImageClaimsNoneOfTheFamily(t *testing.T) {
 	}
 }
 
+// loscoy's relay (v0.1.2670) namespaces its list — openai/gpt-image-1,
+// openai/gpt-image-2 and the rest, all Draws (#4432): the family is the
+// name's own past the namespace, as the bare one a Codex harness asks
+// its provider for. A relay whose list draws none of the family is still
+// not taken to (TestRelayDrawingNoGPTImageClaimsNoneOfTheFamily).
+func TestRelayDrawsTheGPTImageFamilyFromANamespacedList(t *testing.T) {
+	fresh(t)
+	e := &easel{}
+	up := httptest.NewServer(e)
+	defer up.Close()
+	p := provider.Provider{ID: "relay", Name: "Relay", Responses: up.URL + "/v1", Key: "key"}
+	if err := provider.Save(p); err != nil {
+		t.Fatal(err)
+	}
+	if err := catalog.SaveLive(p.ID, p.Responses, []catalog.Model{
+		{ID: "text"},
+		{ID: "openai/gpt-image-1", Draws: true},
+		{ID: "openai/gpt-image-1.5", Draws: true},
+		{ID: "openai/gpt-image-2", Draws: true},
+		{ID: "openai/gpt-image-2.5-flare", Draws: true},
+	}); err != nil {
+		t.Fatal(err)
+	}
+	s := New()
+	code, a, raw := postImages(t, s, "/v1/images/generations", "application/json", `{"model":"gpt-image-2","prompt":"a magpie"}`)
+	if code != 200 || a.Model != "relay/gpt-image-2" {
+		t.Fatalf("%d %s", code, raw)
+	}
+	requests := e.got("/v1/images/generations")
+	if len(requests) != 1 || !strings.Contains(requests[0], `"model":"gpt-image-2"`) {
+		t.Fatalf("asked %v", requests)
+	}
+}
+
+// Codex's native image tool draws with its turn's provider's own list,
+// namespaced or not: the bare gpt-image-2 it asks for draws there as
+// itself, not as the Settings' pick instead of it (#4432).
+func TestCodexNativeDrawsItsOwnModelOnANamespacedRelay(t *testing.T) {
+	fresh(t)
+	relay := drawingRelay(t, "relay", "openai/gpt-image-2.5-flare")
+	st := settings.Load()
+	st.ImageGen = "relay/openai/gpt-image-2.5-flare"
+	if err := settings.Save(st); err != nil {
+		t.Fatal(err)
+	}
+	s := New()
+	drawingMainTurn(t, s, "relay/text", "session-a", "turn-a", "", "magpie-codex")
+	code, answer, raw := drawingToolCall(t, s, "/v1/images/generations", "gpt-image-2", "", "turn-a", "magpie-codex")
+	if code != 200 || answer.Model != "relay/gpt-image-2" {
+		t.Fatalf("%d %s", code, raw)
+	}
+	requests := relay.got("/v1/images/generations")
+	if len(requests) != 1 || !strings.Contains(requests[0], `"model":"gpt-image-2"`) {
+		t.Fatalf("asked %v", requests)
+	}
+}
+
 // Codex's native image tool asks its turn's provider for the one it names
 // (gpt-image-2, #870): on a Codex backend whose list names another of the
 // family, it draws there as the one it asked for, not as magpie's pick
-- 
2.50.1 (Apple Git-155)

```

</details>

**Branch with the commit**: [fix/4432-namespaced-image-relay](https://github.com/ggbdpq/magpie/tree/fix/4432-namespaced-image-relay) (head `0632ba41695c16cb770c327165f69dd19b9b0fcf`).
