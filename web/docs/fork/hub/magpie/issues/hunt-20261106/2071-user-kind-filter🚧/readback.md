Thanks for the review — the diagnosis was right, and the patch wasn't. `withUserKinds` set `Films`/`Draws` on the entries `Available()` hands out, but the one place that reads those flags, `catalog.Chat` (internal/catalog/live.go), had already filtered the fetched list before `Available()` runs; every consumer after it — the editor's chips (`for _, m := range p.Available()` → `out.Models`, and `modelJSON` carries no `Films` at all), `Exposed()`, the gateway's list — went on taking the model as it stood. And my two tests asserted the flags, not the list, which is why they were green on a patch that changes nothing the reporter can see. I've reworked it at the layer you pointed at, and the tests now say who is in the list.

**What changed.** `Available()` itself now leaves out the models the user said make images or videos (`withoutUserKinds`, internal/provider/models.go): membership, not flags — the editor's chips, `Exposed()`, the gateway's list and the CLIs all build on it and follow. `Exposed()` builds no unlisted model for a marked pick any more, the user's word beating the pick. The marks are read only where they can be taken (`MarksKinds`), so a provider that no longer takes them keeps none — that was your point 3.

**The videos and images paths keep the marked models.** They read `KindModels`, whose `hasKindable` used to count "listed or exposed" as had; a marked model leaves both now, so `hasKindable` counts a pick as had whatever its list says. Found by the gateway's own tests: `TestCustomProviderVideoTheUserMarks` and `TestCustomProviderVideoKeepsTheCallersFields` went red on the first cut (a hand-typed video model, marked and picked, fell out of the videos path) and pass with this.

**The editor keeps a way back.** The models the user said make videos are listed apart, as the image ones are (`renderVideomakers` beside `renderDrawers`), and a marked chip in either area wears its kind and is right-clicked to say it again — Auto, image or video, staged as a chat chip's kind is and made with the Save. Out of the chat chips there was no other place to take the mark back. `providerInfo` carries the new `videoIds` and `kinds` for it.

**patch**: branch [`hunt62-a-2071-rework`](https://github.com/ggbdpq/magpie/tree/hunt62-a-2071-rework) on upstream/main `2000ae439`, applies as is.

**Re-verified on upstream/main `2000ae439`, reworked narrower (2026-11-06).** Main moved since this was posted, and it gained the video-models area upstream's own way — `renderVideomakers` beside `renderDrawers`, `filmIds`, ticked to be offered (`HiddenVideomakers`), with `KindModels` already feeding both areas (`customVideomakers`, `Drawers`). The editor's half below is dropped from the follow-up: those areas exist now, and they already list the models the user said make images or videos. What main still lacked was the seating, and the follow-up patch carries just that: `Available()` leaves out the models the user said make images or videos, checked after the ids they are listed by (`ModelKinds` follows a rename, SetModelID); `ExposedOf` builds no unlisted one for a marked pick, the user's word beating the pick; `hasKindable` counts a pick as had whatever its list says. The `MarksKinds` gate and the marks-read-where-they-can-be-taken are as below.

| What | Result |
| --- | --- |
| `TestUserKindLeavesTheChatList`, `TestUserKindBeatsAPick` on `2000ae439`, before the follow-up | red, the same sentences: "Available (the editor's chat chips) still has it: [omni_flash-10s claude-sonnet-4-5]", "Exposed still serves a pick the user said makes videos" |
| Same after | green |
| Ablation: product files back at the parent commit, tests kept | the two red again; green once restored |
| `go test -tags nogui -count=1` of internal/provider, internal/catalog, internal/gateway | ok (the gateway suite whole, 687s, no failure) |
| `go test -tags nogui -run 'ProviderInfo\|Providers\|Model'` of internal/gui | ok |
| targeted `-race` of the two list tests | ok |
| `gofmt -l` internal/provider; `go vet -tags nogui` darwin and `GOOS=linux`; `go build -tags nogui ./...` darwin and `GOOS=linux` | all clean |

The branch carries the follow-up, same name, force-pushed: head `95d3c4a14cae69d4833e2eeef68589c388ea92c6`, the patch below applies as is on `2000ae439`. One gap stays with the areas' own work: a marked chip in the image or video areas ticks on and off but has no right-click to say its kind again, so the way back to Auto waits on that (and there is no CLI or API entrance). Not verified against the reporter's relay (no account here): after updating, omni_flash-10s should leave the chat chips, the agents' lists and the gateway's model list at once, keeping its seat in Video models.

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

<details><summary>patch: provider: a model the user says makes videos or images leaves the chat list (#2071) — git am applies it as is; SHA-256 first 16: 2ff14408321bff05</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 6 Nov 2026 21:46:27 +0800
Subject: [PATCH] provider: a model the user says makes videos or images leaves
 the chat list (#2071)

SetModelKind kept a relay model's kind in settings' ModelKinds, and the
videos and images paths read it, so requests went to the right API - but
the chat list went on serving the model: Available is the list every chat
consumer builds on (the editor's chips, the agents' lists, the gateway's,
the CLIs), and it carried the mark nowhere. Setting a flag on the entries,
as a first patch tried, read nothing after that: the one filter that reads
such flags (catalog.Chat) had run before Available, on the fetched list,
and no consumer of Available looks at a flag. The members leave instead:
Available hands out none of the models the user said make images or
videos, the check standing after the ids they are listed by (ModelKinds
follows a model's listed id, SetModelID), and Exposed builds no unlisted
one for a marked pick, the user's word beating the pick. The marks are
read only where they can be taken (MarksKinds), so a provider that no
longer takes them keeps none, and one said nothing of keeps its vendor's
word. Said back to Auto, the model comes back.

The videos and images paths keep the marked models: hasKindable counts a
pick as had whatever its list says, for a hand-typed model marked and
picked leaves both lists now (a list-fetched one has its list still).
Found by the gateway's own tests: TestCustomProviderVideoTheUserMarks and
TestCustomProviderVideoKeepsTheCallersFields went red without it.

The editor's part of the first rework is not carried: the video and image
areas it added the marked models to are upstream's now, its own way
(renderVideomakers beside renderDrawers, filmIds, ticked to be offered),
and both already list the marked models. A marked chip's way back to Auto
through those areas' right-click is still to come with that work.

The tests say who is in the list, not what a model carries:
TestUserKindLeavesTheChatList (a relay's list saying nothing, a mark
moving the model out of Available and Exposed and back to Auto, the
videos and images paths keeping it) and TestUserKindBeatsAPick (a marked
pick out of Exposed all the same) fail on main.

Fixes #2071

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/modelkind.go           |  10 ++-
 internal/provider/modelkind_list_test.go | 103 +++++++++++++++++++++++
 internal/provider/models.go              |  39 ++++++++-
 3 files changed, 146 insertions(+), 6 deletions(-)
 create mode 100644 internal/provider/modelkind_list_test.go

diff --git a/internal/provider/modelkind.go b/internal/provider/modelkind.go
index f04d02b05..1de30d57b 100644
--- a/internal/provider/modelkind.go
+++ b/internal/provider/modelkind.go
@@ -72,11 +72,13 @@ func (p Provider) KindModels(kind string) []string {
 	return slices.DeleteFunc(out, func(m string) bool { return !p.hasKindable(m) })
 }
 
-// hasKindable is whether p has model: one it serves to chat with, or one
-// its fetched list has that it leaves out of those, as making images or
-// videos.
+// hasKindable is whether p has model: one it serves to chat with, one of its
+// picks (a hand-typed one its list doesn't have is had however its list
+// stands, and one the user said makes images or videos left the chat list,
+// #2071 — the videos and images paths still ask it), or one its fetched list
+// has that it leaves out of those, as making images or videos.
 func (p Provider) hasKindable(model string) bool {
-	if p.serves(model) {
+	if p.serves(model) || slices.Contains(p.Models, model) {
 		return true
 	}
 	all, _ := catalog.LiveAll(p.ID)
diff --git a/internal/provider/modelkind_list_test.go b/internal/provider/modelkind_list_test.go
new file mode 100644
index 000000000..730b8d090
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
index 0eaa0f7d0..99ef774e4 100644
--- a/internal/provider/models.go
+++ b/internal/provider/models.go
@@ -34,8 +34,9 @@ func (p Provider) Available() []catalog.Model {
 	if p.DecideOnly() {
 		return p.decideModels()
 	}
-	// by the ids the user lists them by (SetModelID)
-	ms := p.ids().list(p.available())
+	// by the ids the user lists them by (SetModelID), less those the user
+	// said make images or videos: said so, they are no models to talk to
+	ms := p.withoutUserKinds(p.ids().list(p.available()))
 	if p.Decides() {
 		// a gateway's Jev among its chat models, with its window and input
 		ms = slices.Clone(ms)
@@ -48,6 +49,36 @@ func (p Provider) Available() []catalog.Model {
 	return ms
 }
 
+// withoutUserKinds leaves out the models the user said make images or videos
+// (settings' ModelKinds, SetModelKind): said so, they are no models to talk
+// to, so they leave the chat list itself — the editor's chips, the agents'
+// lists (Exposed) and the gateway's model list are all built on this, and a
+// flag nothing read kept a marked model's seat in every one of those (#2071:
+// a relay's omni_flash-10s, marked "Video model", went on showing where
+// agents chat). Said back to Auto, it comes back. The marks are read only
+// where they can be taken (MarksKinds), so a provider that no longer takes
+// them keeps none, and one said nothing of keeps its vendor's word.
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
@@ -1678,6 +1709,10 @@ func (p Provider) ExposedOf(avail []catalog.Model) []catalog.Model {
 		byID[m.ID] = m
 	}
 	pick := func(ids []string) []catalog.Model {
+		// a model the user said makes images or videos stays out, picked or
+		// not: the user's word beats the pick, or Exposed would build the
+		// marked model again as an unlisted one (#2071)
+		ids = slices.DeleteFunc(slices.Clone(ids), func(id string) bool { return p.ModelKind(id) != "" })
 		var unlisted []catalog.Model
 		for _, id := range ids {
 			if _, ok := byID[id]; !ok {
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [hunt62-a-2071-rework](https://github.com/ggbdpq/magpie/tree/hunt62-a-2071-rework) (head `95d3c4a14cae69d4833e2eeef68589c388ea92c6`).


