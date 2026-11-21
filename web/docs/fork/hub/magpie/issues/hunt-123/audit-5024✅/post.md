Credit to @icutool for the report — the exact serde error and the got-fixed-then-broke-again cycle are what pinned the sync-rewrite overwrite.

## Root cause

magpie writes Codex's `model_catalog_json` file (`magpie-models.json`) itself, and for a model it hands over under its vendor's entry it kept the vendor's `supported_reasoning_levels` **as the vendor wrote them — the `description` field present only when the vendor said one** — and made the level of an effort the user set that the vendor doesn't list as `{"effort": "…"}` alone. Codex 0.166 requires the field on every level, and one missing fails the whole file (`missing field 'description'`), so Codex would not start; and a description added by hand came back missing after the next sync, which rewrote the file the same way again.

## Fix

`internal/codexcat/codexcat.go` (`listedEntry`, the writer of those entries): once the levels are settled, every level that has no description says its display name (`low` → `Low`, `xhigh` → `Extra High`, …, T3 Code's labels). A description the vendor gave stays as it wrote it; entries magpie makes on their own (no vendor entry) have always written a description (an empty one) and are unchanged.

## Verification

| Check | Result |
| --- | --- |
| `TestCodexListedLevelsSayDescription` (new, `internal/codexcat/description_test.go`) | red before the change, green after |
| ablation (product file back at parent `d8b3749ef`) | red again |
| `go test ./internal/codexcat/` | ok |
| `go test -race` (codexcat) | ok |
| `go test -tags nogui ./internal/gateway/` | ok (653s) |
| `go test -tags nogui ./internal/agent/...` | `TestMothX` fails — pre-existing on this machine (known red, plugin-field face, unrelated to this change); every other test passes |
| `gofmt -l internal/codexcat/`, `go vet ./internal/codexcat/`, `go build ./...` | clean |

## Attribution

AI-written (GLM-5.3-Flash via ZCode); author `ggbdpq`.

## Patch

<details>
<summary>0001-codexcat-catalog-level-description.patch (git am)</summary>

```diff
From ecfd02e32c6549dd62b22980f14977f9e67a81e7 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 06:21:42 +0800
Subject: [PATCH] codexcat: a catalog level without a description says the
 effort's display name (#5024)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

Codex 0.166 fails the whole model catalog on a supported_reasoning_levels
entry without a description ("missing field `description`"), so Codex would
not start off magpie's magpie-models.json, and the user's hand-added
descriptions were written over at the next sync. An entry magpie writes
from a vendor's kept the vendor's levels as it wrote them — descriptions
included, but the field itself only when the vendor said it — and made the
levels of the user's efforts the vendor doesn't list as {"effort": …}
alone. Every level of such an entry now says a description: the vendor's
own where it gave one, else the effort's display name (T3 Code's labels).

TestCodexListedLevelsSayDescription fails without the change.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/codexcat/codexcat.go         | 28 +++++++++++++
 internal/codexcat/description_test.go | 59 +++++++++++++++++++++++++++
 2 files changed, 87 insertions(+)
 create mode 100644 internal/codexcat/description_test.go

diff --git a/internal/codexcat/codexcat.go b/internal/codexcat/codexcat.go
index 283f4fdc2..9a826bf2b 100644
--- a/internal/codexcat/codexcat.go
+++ b/internal/codexcat/codexcat.go
@@ -1132,6 +1132,21 @@ func listedEntry(m catalog.Model, priority int, work settings.Settings, autoRevi
 			}
 		}
 	}
+	// every level says its description: Codex 0.166 fails the whole
+	// catalog on one without the field (#5024), so a level the vendor
+	// listed without one — kept as it wrote it, or made for an effort of
+	// the user's the vendor doesn't — says the effort's display name
+	for _, l := range e["supported_reasoning_levels"].([]any) {
+		o, _ := l.(map[string]any)
+		if o == nil {
+			continue
+		}
+		if _, ok := o["description"].(string); ok {
+			continue
+		}
+		ef, _ := o["effort"].(string)
+		o["description"] = effortLabel(ef)
+	}
 	// images, where the user's say (or magpie describing them) differs
 	if in, ok := e["input_modalities"].([]any); ok {
 		has := slices.Contains(in, any("image"))
@@ -1153,6 +1168,19 @@ func listedEntry(m catalog.Model, priority int, work settings.Settings, autoRevi
 	return e, true
 }
 
+// effortLabels are the reasoning efforts' display names, as the pickers say
+// them (T3 Code's labels, internal/agent/t3code.go).
+var effortLabels = map[string]string{"none": "None", "minimal": "Minimal", "low": "Low", "medium": "Medium", "high": "High", "xhigh": "Extra High", "max": "Max", "ultra": "Ultra"}
+
+// effortLabel is the display name of an effort, the effort itself when it
+// has none.
+func effortLabel(ef string) string {
+	if l, ok := effortLabels[ef]; ok {
+		return l
+	}
+	return ef
+}
+
 // Window has one of Codex's own entries say a context window of n tokens
 // (none: as it says), and most at the most it may be raised to (0: as it
 // says). Only those two fields change. An entry whose max_context_window is
diff --git a/internal/codexcat/description_test.go b/internal/codexcat/description_test.go
new file mode 100644
index 000000000..98503e831
--- /dev/null
+++ b/internal/codexcat/description_test.go
@@ -0,0 +1,59 @@
+package codexcat
+
+import (
+	"encoding/json"
+	"testing"
+
+	"github.com/yetone/magpie/internal/catalog"
+)
+
+// #5024: Codex 0.166 fails the whole model catalog on a
+// supported_reasoning_levels entry without a description ("missing field
+// `description`"), so every level of an entry magpie writes from a vendor's
+// carries one: the vendor's own where it gave it, else the effort's display
+// name. That is whether the user's efforts are the vendor's own, whose
+// levels magpie keeps as it wrote them, or differ from them, whose missing
+// ones magpie makes. A level of an entry magpie makes alone has said a
+// description (an empty one) all along.
+func TestCodexListedLevelsSayDescription(t *testing.T) {
+	v1Home(t, `{"etag":"W/\"a\"","models":[]}`)
+	same := json.RawMessage(`{"slug":"glm-5.3","display_name":"GLM-5.3","description":"x","base_instructions":"y",` +
+		`"supported_reasoning_levels":[{"effort":"low","description":"Fastest"},{"effort":"medium"},{"effort":"high"}],` +
+		`"shell_type":"shell_command","visibility":"list"}`)
+	short := json.RawMessage(`{"slug":"kimi","display_name":"Kimi","description":"x","base_instructions":"y",` +
+		`"supported_reasoning_levels":[{"effort":"low"}],` +
+		`"shell_type":"shell_command","visibility":"list"}`)
+	var got struct {
+		Models []struct {
+			Slug   string           `json:"slug"`
+			Levels []map[string]any `json:"supported_reasoning_levels"`
+		} `json:"models"`
+	}
+	if err := json.Unmarshal(Catalog([]catalog.Model{
+		{ID: "relay/glm-5.3", Name: "GLM-5.3", Efforts: []string{"low", "medium", "high"}, Codex: same},
+		{ID: "relay/kimi", Name: "Kimi", Efforts: []string{"low", "xhigh"}, Codex: short},
+		{ID: "or/deepseek-v4", Name: "DeepSeek V4", Efforts: []string{"low", "max"}},
+	}), &got); err != nil || len(got.Models) != 3 {
+		t.Fatalf("%v %v", err, got)
+	}
+	want := map[string]map[string]string{
+		// the vendor's own kept where it gave one, the name where it didn't
+		"relay/glm-5.3": {"low": "Fastest", "medium": "Medium", "high": "High"},
+		// one the vendor doesn't list, made for an effort of the user's
+		"relay/kimi": {"low": "Low", "xhigh": "Extra High"},
+		// magpie's own entry: a description said all along
+		"or/deepseek-v4": {"low": "", "max": ""},
+	}
+	for _, m := range got.Models {
+		if len(m.Levels) != len(want[m.Slug]) {
+			t.Fatalf("%s: levels %v", m.Slug, m.Levels)
+		}
+		for _, l := range m.Levels {
+			ef, _ := l["effort"].(string)
+			d, _ := l["description"].(string)
+			if d != want[m.Slug][ef] {
+				t.Errorf("%s: level %s says description %q, want %q", m.Slug, ef, d, want[m.Slug][ef])
+			}
+		}
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

SHA-256 (first 16): `7f9e317333182f44`

</details>

Branch: https://github.com/ggbdpq/magpie/tree/fix/5024-reasoning-description (head `ecfd02e32c6549dd62b22980f14977f9e67a81e7`)

