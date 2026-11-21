Thanks for the review — the diagnosis was right, and the patch wasn't. `withUserKinds` set `Films`/`Draws` on the entries `Available()` hands out, but the one place that reads those flags, `catalog.Chat` (internal/catalog/live.go), had already filtered the fetched list before `Available()` runs; every consumer after it — the editor's chips (`for _, m := range p.Available()` → `out.Models`, and `modelJSON` carries no `Films` at all), `Exposed()`, the gateway's list — went on taking the model as it stood. And my two tests asserted the flags, not the list, which is why they were green on a patch that changes nothing the reporter can see. I've reworked it at the layer you pointed at, and the tests now say who is in the list.

**What changed.** `Available()` itself now leaves out the models the user said make images or videos (`withoutUserKinds`, internal/provider/models.go): membership, not flags — the editor's chips, `Exposed()`, the gateway's list and the CLIs all build on it and follow. `Exposed()` builds no unlisted model for a marked pick any more, the user's word beating the pick. The marks are read only where they can be taken (`MarksKinds`), so a provider that no longer takes them keeps none — that was your point 3.

**The videos and images paths keep the marked models.** They read `KindModels`, whose `hasKindable` used to count "listed or exposed" as had; a marked model leaves both now, so `hasKindable` counts a pick as had whatever its list says. Found by the gateway's own tests: `TestCustomProviderVideoTheUserMarks` and `TestCustomProviderVideoKeepsTheCallersFields` went red on the first cut (a hand-typed video model, marked and picked, fell out of the videos path) and pass with this.

**The editor keeps a way back.** The models the user said make videos are listed apart, as the image ones are (`renderVideomakers` beside `renderDrawers`), and a marked chip in either area wears its kind and is right-clicked to say it again — Auto, image or video, staged as a chat chip's kind is and made with the Save. Out of the chat chips there was no other place to take the mark back. `providerInfo` carries the new `videoIds` and `kinds` for it.

**patch**: branch [`hunt62-a-2071-rework`](https://github.com/ggbdpq/magpie/tree/hunt62-a-2071-rework) on upstream/main `87d703c5`, applies as is.

| What | Result |
| --- | --- |
| `TestUserKindLeavesTheChatList`, `TestUserKindBeatsAPick` (internal/provider), before the change | red: "Available (the editor's chat chips) still has it: [omni_flash-10s claude-sonnet-4-5]", "Exposed still serves a pick the user said makes videos" |
| Same after | green |
| `TestProviderInfoCarriesUserKinds` (internal/gui), before | build fails: `videoIds`/`kinds` carried by nothing |
| Same after | green |
| `go test -tags nogui -count=1` of internal/provider, internal/gateway, internal/cli | ok |
| `go test -tags nogui -count=1` of internal/gui | ok but for the known `TestProxyCheckSaysAProxyPassedBy` — red at the parent commit `87d703c5` too, re-run there |
| Ablation: product files back at the parent, tests kept | the three tests red again, then green once restored |
| `gofmt -l` of internal/provider, internal/gui; `go vet ./...`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet -tags nogui ./...` | all clean |
| `go build -tags nogui ./...` (darwin), `GOOS=linux` and `GOOS=windows` builds of the root | ok |
| app.js (the areas and menus) | `node --check` only; it has no test rig of its own |

**Not verified**: nothing of this ran against the reporter's relay (no account here) or in a driven browser — the areas' chips and menus are app.js's, whose JSON the Go tests cover but whose rendering nothing on this machine exercises. After updating, re-fetching the provider's list and right-clicking omni_flash-10s in the new Video models area should be the check.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: provider, gui: a model the user says makes videos or images leaves the chat list, and the editor says its kind where it now sits (#2071) — git am applies it as is; SHA-256 first 16: cdb51fe24e382c90</summary>

```patch
From d290df20880f11b90588d5e8af81600a3d5d0ef3 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 22 Oct 2026 21:45:09 +0800
Subject: [PATCH] provider, gui: a model the user says makes videos or images
 leaves the chat list, and the editor says its kind where it now sits (#2071)

SetModelKind kept a relay model's kind in settings' ModelKinds, and the
videos path (KindModels) read it, so requests went to the videos API and
the chip showed its label - but the chat list went on serving the model:
Available is the list every chat consumer builds on (the editor's chips,
Exposed, the gateway's), and it carried the mark nowhere. Setting Films
on the entries, as a first patch tried, read nothing after that: the one
filter that reads the flags (catalog.Chat) had run before Available, on
the fetched list, and no consumer of Available looks at them - so a
marked omni_flash-10s kept its seat in every list. The members leave
instead: Available hands out none of the models the user said make
images or videos, the marks being read only where they can be taken
(MarksKinds), and Exposed builds no unlisted one for a marked pick, the
user's word beating the pick. The videos and images paths keep the
marked models: hasKindable counts a pick as had, however its list stands
(Exposed built an unlisted pick before, and a marked one leaves it now).

The editor lists the video models apart, as the image ones are listed,
and a marked model's chip in either area wears its kind and is
right-clicked to say it again (#1399) - out of the chat chips, there is
no other place to take the mark back to Auto. providerInfo carries the
video ids and the marked kinds for it.

The tests say who is in the list, not what a model carries:
TestUserKindLeavesTheChatList (a relay's list saying nothing, a mark
moving the model out of Available and Exposed and back to Auto, the
videos and images paths keeping it) and TestUserKindBeatsAPick (a marked
pick out of Exposed all the same) fail on main; so does
TestProviderInfoCarriesUserKinds (the editor's models without the marked
ones, videoIds and kinds carried).

Run (branch hunt62-a-2071-rework on upstream/main 87d703c5): gofmt clean;
go vet -tags nogui of internal/provider and internal/gui, clean; go test
-tags nogui -count=1 of internal/provider, internal/gateway and
internal/cli, ok, and of internal/gui ok but for the known
TestProxyCheckSaysAProxyPassedBy (red on main too). Not tried in a
browser: the areas' chips and menus are app.js's, of which there is no
test rig; the JSON they read is the tests'.

Fixes #2071

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gui/assets/app.js               |  76 ++++++++++++++++-
 internal/gui/providers.go                |  27 +++++-
 internal/gui/providers_draw_test.go      |  44 ++++++++++
 internal/provider/modelkind.go           |  10 ++-
 internal/provider/modelkind_list_test.go | 103 +++++++++++++++++++++++
 internal/provider/models.go              |  36 +++++++-
 6 files changed, 286 insertions(+), 10 deletions(-)
 create mode 100644 internal/provider/modelkind_list_test.go

diff --git a/internal/gui/assets/app.js b/internal/gui/assets/app.js
index 90504627..47fbfd50 100644
--- a/internal/gui/assets/app.js
+++ b/internal/gui/assets/app.js
@@ -9255,6 +9255,7 @@ function drawEditor(p, presetID) {
     }
     ed.append(...field(t("Models"), renderModels(p), ""));
     if (p.drawIds?.length) ed.append(...renderDrawers(p));
+    if (p.videoIds?.length) ed.append(...renderVideomakers(p));
     // a subscription's window too: Codex's backend says 272K for models
     // that take 872K (#120)
     const cx = input(draft.contexts || "", t("e.g. 128k · or gpt-6=1m, comma separated"));
@@ -9718,6 +9719,7 @@ function drawEditor(p, presetID) {
   // add page for one where they must type them
   else if (pr?.id === "azure") ed.append(...field(t("Models"), el("div", "hint azure-models", t("No need to type them: once added, magpie lists the deployments this key can call. Type a deployment's name as a model id only if that list can't be fetched.")), ""));
   if (p?.drawIds?.length) ed.append(...renderDrawers(p));
+  if (p?.videoIds?.length) ed.append(...renderVideomakers(p));
   {
     // the window agents are told a model has, over what the vendor or
     // models.dev says: one for all of them, and model=size for one
@@ -10939,7 +10941,6 @@ function renderModels(p) {
   // doesn't (shen-joe, #1399: a relay's video model turned away as one
   // that can't make videos): staged as its API is, made with the Save
   const kindNow = (id) => draft.modelPrefs?.[id]?.kind ?? p.models.find((m) => m.id === id)?.kind ?? "";
-  const KIND_NAMES = { "": "Auto", image: "Image model", video: "Video model" };
   const pickKind = (c, id) => {
     const m = p.models.find((x) => x.id === id) || { id };
     const opts = [{ v: "", name: "Auto", note: "As its vendor's model list and its name say" },
@@ -11691,14 +11692,83 @@ function renderModels(p) {
   return box;
 }
 
+// KIND_NAMES: what a model makes, as the user says it (#1399), by its
+// saved or staged kind
+const KIND_NAMES = { "": "Auto", image: "Image model", video: "Video model" };
+// kindSaid: what a model is said to make now, as staged in the editor's
+// draft, else as saved. A marked model is out of the chat chips (#2071),
+// so its saved kind is read from p.kinds
+const kindSaid = (p, id) => draft.modelPrefs?.[id]?.kind ?? p.kinds?.[id] ?? "";
+// kindBadge: the badge a marked chip wears, saying what the user said it
+// makes, right-click to change
+const kindBadge = (p, id) => {
+  const k = kindSaid(p, id);
+  const tag = el("span", "badge mkind-tag", t(k === "video" ? "video" : "image"));
+  tag.title = t("{kind}, as you said; right-click to change", { kind: t(KIND_NAMES[k]) });
+  return tag;
+};
+// sayKind: the menu of a marked chip in the image or video area — what the
+// model makes, said again where the model now sits (#2071: out of the chat
+// chips, its way back to Auto is here): staged as a chat chip's kind is,
+// made with the Save
+function sayKind(c, p, id) {
+  const opts = [{ v: "", name: "Auto", note: "As its vendor's model list and its name say" },
+    { v: "image", name: "Image model", note: "Draws at the provider's images API (/images/generations), listed under Image generation" },
+    { v: "video", name: "Video model", note: "Makes videos at the provider's videos API (POST /videos, then GET /videos/<id>)" }];
+  openProtoMenu(c, opts, kindSaid(p, id), (v) => {
+    if (v === kindSaid(p, id)) return;
+    const prefs = draft.modelPrefs = draft.modelPrefs || {};
+    prefs[id] = prefs[id] || {};
+    if (v === (p.kinds?.[id] || "")) delete prefs[id].kind; else prefs[id].kind = v;
+    if (!Object.keys(prefs[id]).length) delete prefs[id];
+    const badge = c.querySelector(".mkind-tag");
+    if (badge) badge.remove();
+    if (kindSaid(p, id)) c.append(kindBadge(p, id));
+    status(t(v === "video" ? "{model} makes videos once saved" : v === "image" ? "{model} draws images once saved" : "{model} makes what its vendor's list says once saved", { model: id }), "ok");
+  }, "What this model makes", "model-kind-menu");
+}
+// a marked chip's right-click: its kind alone, the menu a chat chip carries
+// the rest of (testing, its API)
+const kindMenu = (c, p, id) => {
+  c.oncontextmenu = (e) => {
+    e.preventDefault();
+    const again = agentMenu?.anchor === c || protoMenu?.anchor === c;
+    closeAgentMenu();
+    closeProtoMenu();
+    if (again) return;
+    sayKind(c, p, id);
+  };
+};
 // renderDrawers: the provider's image models. Agents don't chat with them,
 // so they aren't among its Models; they are listed to say they are there,
-// and one is picked in Settings → Images.
+// and one is picked in Settings → Images. One the user said draws (#1399)
+// sits here too since it left the chat list (#2071), its chip right-clicked
+// to say its kind again
 function renderDrawers(p) {
   const chips = el("div", "mchips");
-  for (const id of p.drawIds) chips.append(el("span", "mchip ro", id));
+  for (const id of p.drawIds) {
+    const c = el("span", "mchip", id);
+    if (p.kinds?.[id]) {
+      c.append(kindBadge(p, id));
+      kindMenu(c, p, id);
+    } else c.classList.add("ro");
+    chips.append(c);
+  }
   return field(t("Image models"), chips, t("Agents don't chat with these, so they aren't among its models: the one that draws is picked in Settings → Images."));
 }
+// renderVideomakers: the models the user said make videos (#1399), listed
+// apart since they left the chat list (#2071): requests go to the
+// provider's videos API, and a chip is right-clicked to say its kind again
+function renderVideomakers(p) {
+  const chips = el("div", "mchips");
+  for (const id of p.videoIds || []) {
+    const c = el("span", "mchip", id);
+    c.append(kindBadge(p, id));
+    kindMenu(c, p, id);
+    chips.append(c);
+  }
+  return field(t("Video models"), chips, t("Agents don't chat with these: requests for one go to the provider's videos API."));
+}
 
 // renderRouting: how the gateway spreads requests over the keys or
 // accounts a provider has on, and how long a conversation stays with the
diff --git a/internal/gui/providers.go b/internal/gui/providers.go
index 94086766..c513d928 100644
--- a/internal/gui/providers.go
+++ b/internal/gui/providers.go
@@ -238,8 +238,16 @@ type providerJSON struct {
 	Exposed   int         `json:"exposed"`           // how many reach the agents
 	Draws     int         `json:"draws,omitempty"`   // how many of its models draw images (gateway.Drawers)
 	DrawIDs   []string    `json:"drawIds,omitempty"` // those models' ids, listed apart in its editor
-	Unlisted  bool        `json:"unlisted"`          // its models serve only through routing groups
-	NoModels  bool        `json:"noModels"`          // Select none: none of its models served (#1818)
+	// VideoIDs are the models the user said make videos (#1399), listed
+	// apart in its editor since they left the chat list (#2071): requests
+	// go to the provider's videos API
+	VideoIDs []string `json:"videoIds,omitempty"`
+	// Kinds are what the user said a model makes, by model id: a marked
+	// model's chip in the image or video area says its kind again by
+	// right-click, there being no chat chip for it any more (#2071)
+	Kinds    map[string]string `json:"kinds,omitempty"`
+	Unlisted bool              `json:"unlisted"` // its models serve only through routing groups
+	NoModels bool              `json:"noModels"` // Select none: none of its models served (#1818)
 	// Groups are the routing groups ("group/<id>") each of its models is
 	// in, by model id: what an unlisted one is still used through, and the
 	// editor names those in none
@@ -815,6 +823,21 @@ func providerInfoWith(p provider.Provider, agents []agentUse, desktop map[string
 		out.DrawIDs = append(out.DrawIDs, m.ID)
 	}
 	out.Draws = len(out.DrawIDs)
+	// what the user said its models make (#1399): the video ones are listed
+	// apart too, now they have left the chat list (#2071), and every marked
+	// one's kind goes beside it for its area chip to say again by
+	// right-click
+	out.Kinds = map[string]string{}
+	for _, id := range p.KindModels(provider.KindImage) {
+		out.Kinds[id] = provider.KindImage
+	}
+	for _, id := range p.KindModels(provider.KindVideo) {
+		out.Kinds[id] = provider.KindVideo
+		out.VideoIDs = append(out.VideoIDs, id)
+	}
+	if len(out.Kinds) == 0 {
+		out.Kinds = nil
+	}
 	if t, ok := p.Listed(); ok {
 		out.Fetched = &t
 	}
diff --git a/internal/gui/providers_draw_test.go b/internal/gui/providers_draw_test.go
index 854af4b2..310751a4 100644
--- a/internal/gui/providers_draw_test.go
+++ b/internal/gui/providers_draw_test.go
@@ -5,6 +5,7 @@ import (
 	"net/http"
 	"net/http/httptest"
 	"os"
+	"slices"
 	"strings"
 	"testing"
 
@@ -39,3 +40,46 @@ func TestProviderInfoListsImageModels(t *testing.T) {
 		}
 	}
 }
+
+// A model the user said makes videos or images (SetModelKind, #1399) leaves
+// the chat list (#2071), the editor lists the video ones apart, and either
+// area carries the marked model's kind, for its chip to say it again by
+// right-click.
+func TestProviderInfoCarriesUserKinds(t *testing.T) {
+	t.Setenv("HOME", t.TempDir())
+	t.Setenv("USERPROFILE", os.Getenv("HOME"))
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		io.WriteString(w, `{"data":[{"id":"claude-sonnet-4-5"},{"id":"omni_flash-10s"}]}`)
+	}))
+	defer up.Close()
+	p := provider.Provider{ID: "relay", Name: "Relay", Chat: up.URL + "/v1", Key: "key"}
+	if err := provider.Save(p); err != nil {
+		t.Fatal(err)
+	}
+	if _, err := p.Fetch(t.Context()); err != nil {
+		t.Fatal(err)
+	}
+	if err := provider.SetModelKind("relay/omni_flash-10s", provider.KindVideo); err != nil {
+		t.Fatal(err)
+	}
+	if err := provider.SetModelKind("relay/claude-sonnet-4-5", provider.KindImage); err != nil {
+		t.Fatal(err)
+	}
+	j := providerInfo(p, nil)
+	for _, m := range j.Models {
+		if m.ID == "omni_flash-10s" || m.ID == "claude-sonnet-4-5" {
+			t.Fatalf("a marked model among the chat ones: %s", m.ID)
+		}
+	}
+	if got := strings.Join(j.VideoIDs, ","); got != "omni_flash-10s" {
+		t.Fatalf("videoIds %q", got)
+	}
+	if !slices.Contains(j.DrawIDs, "claude-sonnet-4-5") {
+		t.Fatalf("drawIds %v lost the one said to draw", j.DrawIDs)
+	}
+	if j.Kinds["omni_flash-10s"] != provider.KindVideo || j.Kinds["claude-sonnet-4-5"] != provider.KindImage {
+		t.Fatalf("kinds %v", j.Kinds)
+	}
+}
diff --git a/internal/provider/modelkind.go b/internal/provider/modelkind.go
index 4ef8a361..4ef91a6b 100644
--- a/internal/provider/modelkind.go
+++ b/internal/provider/modelkind.go
@@ -72,11 +72,13 @@ func (p Provider) KindModels(kind string) []string {
 	return slices.DeleteFunc(out, func(m string) bool { return !p.hasKindable(m) })
 }
 
-// hasKindable is whether p has model: one it serves to chat with, or one
-// its fetched list has that it leaves out of those, as making images or
-// videos.
+// hasKindable is whether p has model: one it serves to chat with, one of
+// its picks (Exposed builds an unlisted pick it has, so a pick is had
+// however its list stands, and one the user said makes images or videos is
+// out of that list, #2071), or one its fetched list has that it leaves out
+// of those, as making images or videos.
 func (p Provider) hasKindable(model string) bool {
-	if p.serves(model) {
+	if p.serves(model) || slices.Contains(p.Models, model) {
 		return true
 	}
 	all, _ := catalog.LiveAll(p.ID)
diff --git a/internal/provider/modelkind_list_test.go b/internal/provider/modelkind_list_test.go
new file mode 100644
index 00000000..730b8d09
--- /dev/null
+++ b/internal/provider/modelkind_list_test.go
@@ -0,0 +1,103 @@
+package provider
+
+import (
+	"path/filepath"
+	"slices"
+	"testing"
+
+	"github.com/yetone/magpie/internal/catalog"
+)
+
+// kindHome is a sandbox home with a relay whose fetched list says nothing
+// of what its models make: omni_flash-10s and a chat model beside it, as
+// the relay of #2071 lists them.
+func kindHome(t *testing.T) Provider {
+	t.Helper()
+	home := t.TempDir()
+	t.Setenv("HOME", home)
+	t.Setenv("USERPROFILE", home)
+	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
+	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
+	p := Provider{ID: "relay", Name: "Relay", Chat: "http://127.0.0.1:9/v1", Key: "k"}
+	if err := Save(p); err != nil {
+		t.Fatal(err)
+	}
+	if err := catalog.SaveLive("relay", "http://127.0.0.1:9/v1", []catalog.Model{
+		{ID: "omni_flash-10s", Name: "Omni Flash"},
+		{ID: "claude-sonnet-4-5", Name: "Claude Sonnet 4.5"},
+	}); err != nil {
+		t.Fatal(err)
+	}
+	return p
+}
+
+func listOf(ms []catalog.Model) []string {
+	var out []string
+	for _, m := range ms {
+		out = append(out, m.ID)
+	}
+	return out
+}
+
+func hasModel(ms []catalog.Model, id string) bool {
+	return slices.ContainsFunc(ms, func(m catalog.Model) bool { return m.ID == id })
+}
+
+// A model the user said makes videos or images (SetModelKind, #1399) leaves
+// the chat list itself: the editor's chips, the agents' lists and the
+// gateway's are all built on Available and Exposed, and a flag none of them
+// read kept a marked model's seat in every one (#2071: a relay's
+// omni_flash-10s, marked "Video model", went on showing where agents chat).
+// Said back to Auto, it comes back.
+func TestUserKindLeavesTheChatList(t *testing.T) {
+	p := kindHome(t)
+	if !hasModel(p.Available(), "omni_flash-10s") || !hasModel(p.Exposed(), "omni_flash-10s") {
+		t.Fatalf("an unmarked model left the chat list: available %v, exposed %v", listOf(p.Available()), listOf(p.Exposed()))
+	}
+	if err := SetModelKind("relay/omni_flash-10s", KindVideo); err != nil {
+		t.Fatal(err)
+	}
+	if hasModel(p.Available(), "omni_flash-10s") {
+		t.Fatalf("Available (the editor's chat chips) still has it: %v", listOf(p.Available()))
+	}
+	if hasModel(p.Exposed(), "omni_flash-10s") {
+		t.Fatalf("Exposed (the agents' lists) still has it: %v", listOf(p.Exposed()))
+	}
+	// the videos path keeps it: a marked model is asked at the videos API
+	if got := p.KindModels(KindVideo); !slices.Equal(got, []string{"omni_flash-10s"}) {
+		t.Fatalf("the videos path lost it: %v", got)
+	}
+	// said image, the same
+	if err := SetModelKind("relay/claude-sonnet-4-5", KindImage); err != nil {
+		t.Fatal(err)
+	}
+	if hasModel(p.Available(), "claude-sonnet-4-5") || hasModel(p.Exposed(), "claude-sonnet-4-5") {
+		t.Fatalf("the image mark left it in the chat list: available %v, exposed %v", listOf(p.Available()), listOf(p.Exposed()))
+	}
+	if got := p.KindModels(KindImage); !slices.Equal(got, []string{"claude-sonnet-4-5"}) {
+		t.Fatalf("the images path lost it: %v", got)
+	}
+	if err := SetModelKind("relay/omni_flash-10s", ""); err != nil {
+		t.Fatal(err)
+	}
+	if !hasModel(p.Available(), "omni_flash-10s") || !hasModel(p.Exposed(), "omni_flash-10s") {
+		t.Fatalf("said back to Auto it didn't come back: available %v, exposed %v", listOf(p.Available()), listOf(p.Exposed()))
+	}
+}
+
+// A pick the user later said makes videos stays out of the agents' list all
+// the same: Exposed builds a picked model the list no longer offers as an
+// unlisted one, and the user's word beats the pick.
+func TestUserKindBeatsAPick(t *testing.T) {
+	p := kindHome(t)
+	p.Models = []string{"omni_flash-10s", "claude-sonnet-4-5"}
+	if err := SetModelKind("relay/omni_flash-10s", KindVideo); err != nil {
+		t.Fatal(err)
+	}
+	if hasModel(p.Exposed(), "omni_flash-10s") {
+		t.Fatalf("Exposed still serves a pick the user said makes videos: %v", listOf(p.Exposed()))
+	}
+	if !hasModel(p.Exposed(), "claude-sonnet-4-5") {
+		t.Fatalf("Exposed lost a pick nothing was said of: %v", listOf(p.Exposed()))
+	}
+}
diff --git a/internal/provider/models.go b/internal/provider/models.go
index ff394a81..d90ae6ad 100644
--- a/internal/provider/models.go
+++ b/internal/provider/models.go
@@ -32,7 +32,7 @@ func (p Provider) Available() []catalog.Model {
 	if p.DecideOnly() {
 		return p.decideModels()
 	}
-	ms := p.available()
+	ms := p.withoutUserKinds(p.available())
 	if p.Decides() {
 		// a gateway's Jev among its chat models, with its window and input
 		ms = slices.Clone(ms)
@@ -45,6 +45,36 @@ func (p Provider) Available() []catalog.Model {
 	return ms
 }
 
+// withoutUserKinds leaves out the models the user said make images or videos
+// (settings' ModelKinds, SetModelKind): said so, they are no models to talk
+// to, so they leave the chat list itself — the editor's chips, the agents'
+// lists (Exposed) and the gateway's all follow. A flag was not enough
+// (#2071: a relay's omni_flash-10s, marked "Video model", carried Films
+// nowhere read and kept its seat in every one of those). A model the user
+// said nothing of keeps its vendor's word; the marks are read only where
+// they can be taken (MarksKinds), so a provider that no longer takes them
+// keeps none.
+func (p Provider) withoutUserKinds(ms []catalog.Model) []catalog.Model {
+	if !p.MarksKinds() || len(ms) == 0 {
+		return ms
+	}
+	s := heldSettings()
+	if len(s.ModelKinds) == 0 {
+		return ms
+	}
+	marked := false
+	for _, m := range ms {
+		if modelKindIn(s, p.ID, m.ID) != "" {
+			marked = true
+			break
+		}
+	}
+	if !marked {
+		return ms
+	}
+	return slices.DeleteFunc(slices.Clone(ms), func(m catalog.Model) bool { return modelKindIn(s, p.ID, m.ID) != "" })
+}
+
 func (p Provider) available() []catalog.Model {
 	signedIn := p.Account != nil && p.Account.models != nil
 	var known []catalog.Model
@@ -1446,6 +1476,10 @@ func (p Provider) Exposed() []catalog.Model {
 		byID[m.ID] = m
 	}
 	pick := func(ids []string) []catalog.Model {
+		// a model the user said makes images or videos stays out, picked
+		// or not: the user's word beats the pick, or Exposed would build
+		// the marked model again as an unlisted one (#2071)
+		ids = slices.DeleteFunc(slices.Clone(ids), func(id string) bool { return p.ModelKind(id) != "" })
 		var unlisted []catalog.Model
 		for _, id := range ids {
 			if _, ok := byID[id]; !ok {
-- 
2.50.1 (Apple Git-155)
```

</details>

Branch with the commit: [hunt62-a-2071-rework](https://github.com/ggbdpq/magpie/tree/hunt62-a-2071-rework) (head `d290df20880f11b90588d5e8af81600a3d5d0ef3`).

