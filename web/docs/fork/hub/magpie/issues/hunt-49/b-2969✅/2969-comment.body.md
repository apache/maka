The numbers on the two sides of the same card disagree because they aggregate at two different keys, both in `toolUse` (`internal/sessions/stats.go`, the `Usage > Sessions` overview's `tools` payload; the Svelte-free JS in `assets/plugins/usage/page.js` only renders what that Go function sends):

- the left detail list keyed its rows by the **raw reported name** (`tools[name]`), so one tool read as two;
- the right legend keyed by **kind** (`cats[ToolCategory(name)]`), and `ToolCategory`'s switch lists both casings (`"bash"`, `"Bash"`, `"read"`, `"Read"`, …), so it already merges them.

From the report:

| Tool | Left, before | Calls | Sessions | | Right legend |
|---|---|---|---|---|---|
| Bash | `bash` / `Bash` | 1.4K + 779 | 20 + 2 | → | `Bash 2.2K` |
| Read | `read` / `Read` | 192 + 123 | 15 + 1 | → | `Read 315` |
| Write | `write` / `Write` | 64 + 56 | 13 + 1 | → | `Write 120` |

Each right-hand figure is exactly the sum of its left-hand pair — the left just never added them up. The fix folds a tool's spellings into one row at the aggregation: the detail list now groups by the case-folded name (`strings.ToLower`), a session that called both ways counts its session once (a per-session seen-set on the folded key — no session ids needed in the data model, `Summary` is already per-session), and the row is displayed the way the summary spells it: when a tool is its own kind save for the case, the row takes the summary's capitalized form (`bash` → `Bash`, the reporter's display suggestion), otherwise it keeps its most-called original spelling (ties broken alphabetically, so the display is stable across refreshes). Tools that only share a kind — two `mcp__` tools, `BashOutput` beside `Bash` — stay apart, as the detail list should. Storage is untouched: `usage.jsonl` keeps the names as the callers reported them, and the summary's per-kind list and weekly bars are unchanged.

Branch: [`hunt49-b-tool-case`](https://github.com/ggbdpq/magpie/tree/hunt49-b-tool-case), one commit on top of upstream `79160455`; the patch below applies with `git am`.

## What changed

- `toolUse` (`internal/sessions/stats.go`) now keys the detail rows by `strings.ToLower(name)` and sums calls under that one key; the shown name is `ToolCategory(name)`'s form when the tool is its kind save for case, else the spelling with the most calls.
- `t.Sessions` increments once per session per folded key (was: once per raw name, so a session that called `read` and `Read` counted twice against the pair of rows).
- The summary list (`Categories`) and the weekly bars (already category-keyed) are byte-for-byte the same computation as before.
- New table-driven `TestToolUseMergesSpellings` in `internal/sessions/stats_tools_test.go` covers the report's shape: 20 sessions of `bash` (70 calls each) plus one of `Bash` (779) must read as one `Bash` row of 2,179 calls in 21 sessions; a session that called both `read` and `Read` counts once; two `mcp__github__*` tools stay apart.

## Red before the fix

The new test, run against the old aggregation (change reverted, test kept):

```
--- FAIL: TestToolUseMergesSpellings (0.00s)
    stats_tools_test.go:172: one tool spelled two ways is one row, spelled as its summary does: top [{Name:bash Category:Bash Calls:1400 Sessions:20} {Name:Bash Category:Bash Calls:779 Sessions:1}], want [{Name:Bash Category:Bash Calls:2179 Sessions:21}]
    stats_tools_test.go:172: a session that called both ways counts once: top [{Name:Read Category:Read Calls:111 Sessions:1} {Name:read Category:Read Calls:24 Sessions:2}], want [{Name:Read Category:Read Calls:135 Sessions:2}]
FAIL    github.com/yetone/magpie/internal/sessions
```

The first line is the report's table in Go structs. Restored, the test passes.

## Verification

| Check | Command | Result |
|---|---|---|
| New test, fixed code | `go test ./internal/sessions/ -run TestToolUseMergesSpellings -count=1` | pass |
| New test, fix reverted (ablation) | `git apply -R <patch>` + same command | fails as above |
| Owning package, full suite | `go test ./internal/sessions/ -count=1` | ok |
| Format | `gofmt -l` on the two touched files | clean |
| Vet | `go vet ./internal/sessions/` | clean |
| Build | `go build ./...` | ok (pre-existing macOS cgo/ld warnings only) |

## Siblings

- `usage.jsonl` storage: untouched, as scoped — the raw reported names are kept, only the card's aggregation folds them.
- The summary's per-kind list itself still buckets by `ToolCategory`'s synonym table, not by name — that is its job; one residual nuance there is that a lowercase `task` is not in `ToolCategory`'s Task case (it counts under "Other" in the legend while the detail row folds it into `Task`), pre-existing and untouched here.
- Other aggregations of tool names on this card: the "By week" bars are already category-keyed (`pd.tools[ToolCategory(name)]`) and unaffected; the "Top skills" card keys by skill name, which has no case-variant pairs in practice; the models and projects bars key by identifiers.
- The card's renderer (`assets/plugins/usage/page.js`) is data-driven and unchanged; a merged row shows the same name its kind dot was already colored by.

## Not verified

- The reporter's exact dataset is not available to me; the fixtures are shaped like their table (the 1.4K/779 split, per-session counts, one session calling both spellings) but the real-world numbers, percentages and rounding in the UI are not reproduced here.
- The card was not exercised in a browser in this environment (Playwright is not installed here; `node --test internal/gui/tests/sessions-overview.test.cjs` cannot load its `playwright` module). That test stubs `/api/sessions/overview` client-side, so it does not reach the Go aggregation this patch changes; it verifies the renderer, which is untouched.

**AI**: written with an AI coding agent; I've read the whole diff and can answer questions on it myself. The model name is in the commit's trailer.

**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.

<details><summary>patch — usage: the tool list groups tools case-insensitively, as its summary does (#2969)</summary>

```patch
From 8107cb2fb7a3bd288b95342e0182feff1602050e Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 20 Oct 2026 05:27:24 +0800
Subject: [PATCH] usage: the tool list groups tools case-insensitively, as its
 summary does (#2969)

What changed
- toolUse now folds a tool's spellings into one row of the sessions'
  "Tool use" detail list: its calls and sessions are summed under one
  case-insensitive name, the row is shown by the summary's own spelling
  when the tool is its kind save for the case ("bash" as "Bash"), and by
  its most called spelling otherwise. A session that called both ways
  counts once.
- The summary's per-kind list ("Bash 2.2K") already merged the spellings,
  via ToolCategory; the detail list keyed its rows by the raw name, so
  the same tool read as two.

Why (issue #2969)
The card's left list split `bash` (1.4K calls, 20 sessions) from `Bash`
(779, 2), `read` (192, 15) from `Read` (123, 1) and `write` (64, 13) from
`Write` (56, 1), while the right legend showed one Bash 2.2K, Read 315,
Write 120 - the sums of each pair. Same card, two answers. The detail
rows now answer with the summary.

Run
- go test ./internal/sessions/ -run TestToolUseMergesSpellings: fails on
  the old code (the split above), passes on the new; a session that
  called `read` and `Read` counts once, and tools that only share a kind
  (two mcp__ tools) stay apart.
- go test ./internal/sessions/: ok.
- gofmt -l on the touched files: clean; go vet ./internal/sessions/: clean;
  go build ./...: ok.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/sessions/stats.go            | 28 ++++++++---
 internal/sessions/stats_tools_test.go | 68 +++++++++++++++++++++++++++
 2 files changed, 90 insertions(+), 6 deletions(-)

diff --git a/internal/sessions/stats.go b/internal/sessions/stats.go
index 67c8a10d..2bf0aec7 100644
--- a/internal/sessions/stats.go
+++ b/internal/sessions/stats.go
@@ -572,10 +572,13 @@ func shapes(in []Summary) map[string]Shape {
 	return out
 }
 
-// toolUse sums up the sessions' tool calls, the n most called.
+// toolUse sums up the sessions' tool calls, the n most called. The callers
+// spell a tool's name either way ("bash", "Bash"), so its spellings are one
+// tool here, shown as its summary spells it.
 func toolUse(in []Summary, first time.Time, n int) ToolUse {
 	out := ToolUse{Top: []ToolStat{}, Categories: []ToolStat{}, Weeks: []ToolWeek{}}
 	tools, cats := map[string]*ToolStat{}, map[string]*ToolStat{}
+	shown, said := map[string]string{}, map[string]int{} // the spelling a tool is shown by, the calls each spelling has
 	weeks := map[string]map[string]int{}
 	for _, s := range in {
 		if s.ToolCalls == 0 {
@@ -583,15 +586,23 @@ func toolUse(in []Summary, first time.Time, n int) ToolUse {
 		}
 		out.Sessions++
 		out.Calls += s.ToolCalls
-		seen := map[string]bool{}
+		seen, seenTool := map[string]bool{}, map[string]bool{}
 		for name, c := range s.tools {
-			t := tools[name]
+			key := strings.ToLower(name) // one tool apiece, its spellings together
+			t := tools[key]
 			if t == nil {
 				t = &ToolStat{Name: name, Category: ToolCategory(name)}
-				tools[name] = t
+				tools[key] = t
 			}
 			t.Calls += c
-			t.Sessions++
+			if !seenTool[key] {
+				seenTool[key] = true
+				t.Sessions++
+			}
+			said[name] += c
+			if best := shown[key]; best == "" || said[name] > said[best] || (said[name] == said[best] && name < best) {
+				shown[key] = name // its most called spelling, the shorter name on a tie
+			}
 			cat := cats[t.Category]
 			if cat == nil {
 				cat = &ToolStat{Name: t.Category}
@@ -619,7 +630,12 @@ func toolUse(in []Summary, first time.Time, n int) ToolUse {
 			}
 		}
 	}
-	for _, t := range tools {
+	for key, t := range tools {
+		t.Name = shown[key]
+		t.Category = ToolCategory(t.Name)
+		if strings.EqualFold(t.Name, t.Category) {
+			t.Name = t.Category // "bash" shown as the summary's "Bash"
+		}
 		out.Top = append(out.Top, *t)
 	}
 	for _, c := range cats {
diff --git a/internal/sessions/stats_tools_test.go b/internal/sessions/stats_tools_test.go
index 2506d9c3..a5a40103 100644
--- a/internal/sessions/stats_tools_test.go
+++ b/internal/sessions/stats_tools_test.go
@@ -3,7 +3,9 @@ package sessions
 import (
 	"os"
 	"path/filepath"
+	"reflect"
 	"testing"
+	"time"
 )
 
 // The messages each way, the tools called and the skills called up are
@@ -109,6 +111,72 @@ func TestStatsToolsAndSkills(t *testing.T) {
 	}
 }
 
+// TestToolUseMergesSpellings: the callers spell a tool's name either way
+// ("bash" and "Bash", "read" and "Read"), so the card's detail list counts
+// one tool apiece whatever the case: its spellings are one row, shown as its
+// summary spells it, a session that called both ways counted once; tools
+// that only share a kind stay apart, spelled as called.
+func TestToolUseMergesSpellings(t *testing.T) {
+	bash := func(n int) []Summary {
+		in := []Summary{}
+		for i := 0; i < n; i++ {
+			in = append(in, Summary{ToolCalls: 70, tools: map[string]int{"bash": 70}})
+		}
+		return in
+	}
+	tests := []struct {
+		name  string
+		in    []Summary
+		top   []ToolStat // the card's rows, in its order
+		cats  []ToolStat // the summary's rows, when said
+		calls int
+		sess  int
+	}{
+		{
+			// the issue's shape: 1.4K "bash" calls beside 779 "Bash" ones,
+			// read as the summary reads them, "Bash 2.2K"
+			name:  "one tool spelled two ways is one row, spelled as its summary does",
+			in:    append(bash(20), Summary{ToolCalls: 779, tools: map[string]int{"Bash": 779}}),
+			top:   []ToolStat{{Name: "Bash", Category: "Bash", Calls: 2179, Sessions: 21}},
+			cats:  []ToolStat{{Name: "Bash", Calls: 2179, Sessions: 21}},
+			calls: 2179,
+			sess:  21,
+		},
+		{
+			name: "a session that called both ways counts once",
+			in: []Summary{
+				{ToolCalls: 12, tools: map[string]int{"read": 12}},
+				{ToolCalls: 123, tools: map[string]int{"read": 12, "Read": 111}},
+			},
+			top:   []ToolStat{{Name: "Read", Category: "Read", Calls: 135, Sessions: 2}},
+			calls: 135,
+			sess:  2,
+		},
+		{
+			name: "tools that only share a kind stay apart",
+			in:   []Summary{{ToolCalls: 12, tools: map[string]int{"mcp__github__create_issue": 5, "mcp__github__list_issues": 7}}},
+			top: []ToolStat{
+				{Name: "mcp__github__list_issues", Category: "Tool", Calls: 7, Sessions: 1},
+				{Name: "mcp__github__create_issue", Category: "Tool", Calls: 5, Sessions: 1},
+			},
+			calls: 12,
+			sess:  1,
+		},
+	}
+	for _, test := range tests {
+		tu := toolUse(test.in, time.Time{}, 10)
+		if tu.Calls != test.calls || tu.Sessions != test.sess {
+			t.Errorf("%s: %d calls, %d sessions, want %d and %d", test.name, tu.Calls, tu.Sessions, test.calls, test.sess)
+		}
+		if !reflect.DeepEqual(tu.Top, test.top) {
+			t.Errorf("%s: top %+v, want %+v", test.name, tu.Top, test.top)
+		}
+		if test.cats != nil && !reflect.DeepEqual(tu.Categories, test.cats) {
+			t.Errorf("%s: categories %+v, want %+v", test.name, tu.Categories, test.cats)
+		}
+	}
+}
+
 // TestShapesMinutesWithoutMessages: a session whose agent tells no messages
 // (pi, grok…) still counts by its minutes at work, and only there.
 func TestShapesMinutesWithoutMessages(t *testing.T) {
-- 
2.50.1 (Apple Git-155)

```

</details>
