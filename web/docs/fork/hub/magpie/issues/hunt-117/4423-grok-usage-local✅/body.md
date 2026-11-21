Grok Build's own calls (straight to x.ai, not through magpie's gateway) never reached the Usage request ledger: with Local session selected, the models Kimi, Claude, Codex and DeepSeek Harness show and no Grok Build model does, while Usage → Sessions lists `grok-4.7-build` and `grok-4.7-mini` tokens for the same sessions. The readers `callSources()` and `wholeCallReaders`/`lineCallReaders` had no Grok Build entry; Kimi got one in #1607.

This reads the same `updates.jsonl` the Sessions page reads (`grokFiles`), the way `parseGrok` counts them: each `turn_completed` is a call per model in `usage.modelUsage`, on that model's own counts (`grokUsage.tokens`: input without what the cache held, output as is, cache read and write kept apart), the call's time the line's timestamp. An empty `modelUsage` falls back to the session's `current_model_id`, else `grok`. A subagent's turns are in its own folder, calls of its own session; a fork counts the lines written from its `created_at` on, so what it copied from its source stays counted where it was first written. A call made through magpie's gateway is the gateway's to count: the ledger matches these calls with its records through the existing `gatewayMatches` and leaves the matched out of Local session. The `turn_completed` lines carry no message id, so none is matched on, as the report asks.

It is a line call source (`callSources`, `lineCallReaders`), as Kimi's and Pi's are: Grok Build only appends to `updates.jsonl`, so a file that grew is read on from where the last read left off, and the carry (the session's model and, for a fork, the time its source's lines were copied before) is kept in the call disk shard as Pi's is. A read that fails changes nothing that was read before, as for the other line readers. The subsystem pages (Usage → Sessions) are unchanged.

Verification (all on this branch, `go` 1.26 darwin/arm64, temp HOME):

| Check | Result |
|---|---|
| TestGrokCalls, TestGrokCallsForkKeepsItsOwnTurns (new) | fail on the old code with zero Grok calls (the reported symptom); pass after: a = 3 calls (grok-4.7-build ×2 + grok-4.7-mini), the subagent folder b = its own 1, the fork c = only the turn written after its `created_at` (time 1790499630), d = none; by model grok-4.7-build {3, in 800, out 130, cache-read 3100}, grok-4.7-mini {2, in 300, out 30, cache-read 100} |
| Ablation (product files reverted, tests kept) | red again, `sessions with calls map[]` |
| `go test -tags nogui -count=1 ./internal/sessions/` | ok (11.6s) |
| Targeted `-race` (Grok, Kimi, Pi, concurrent-read tests) | ok |
| `go vet` darwin / GOOS=linux / GOOS=windows | pass |
| `go build ./internal/sessions/` darwin / GOOS=linux / GOOS=windows | pass |
| `gofmt -l internal/sessions` | clean |

Not verified: real Grok Build was not exercised on this machine (no Grok Build sessions here); correctness rests on the committed fixture sessions and the file semantics the report and liubing0806 documented. liubing0806's routing note stands as the report sets it: a `turn_completed` that aggregates several API requests (`modelCalls` > 1) may stay unmatched against its individual gateway records and appear in both ledgers; this change adds no message-id dedupe and no matcher change. `GOOS=linux go build ./...` fails in this environment inside wails v3 beta's own Linux files (`undefined: pointer`) — the clean base f3551387c fails the same way, so the package builds and vets above stand in for it.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>.`

<details><summary>patch: sessions: Grok Build's own calls reach Usage, read from its updates (#4423) — git am applies it as is; SHA-256 first 16: 05d2d429c299d984</summary>

```patch
From 9c545e469429f818081e1ee7291ebb782410fcb7 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 2 Nov 2026 21:36:54 +0800
Subject: [PATCH] sessions: Grok Build's own calls reach Usage, read from its
 updates (#4423)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

Usage counts the gateway's calls and the calls the agents' own session
files record (sessions.Calls). Grok Build had no reader, so its calls
straight to x.ai never showed (liubing0806: the menu-bar Usage tab with
Local session selected lists Kimi's, Claude's, Codex's and DeepSeek
Harness's models, no Grok Build model, while Usage → Sessions shows the
tokens of the same sessions).

The reader (calls_grok.go) reads the same updates.jsonl the Sessions
page reads (grokFiles), as parseGrok counts them: each turn_completed's
usage a call per model in modelUsage, on that model's own counts
(grokUsage.tokens: input without what the cache held), the turn's time
the line's; an empty modelUsage falls back to the session's model
(current_model_id, else "grok"). A subagent's turns are in its own
folder, calls of its own session. A fork counts the lines written from
its created_at on: what it copied from its source was counted where it
was first written. A call made through magpie's gateway is the
gateway's to count; the ledger matches these calls with its records as
it matches the others' (gatewayMatches) and leaves the matched out of
Local session. The turn_completed lines carry no message id, so none is
matched on.

It is a line call source (callSources, lineCallReaders): Grok Build
only appends to updates.jsonl, so a file that grew is read on from
where the last read left off, its carry (the session's model and, for a
fork, the time its source's lines were copied before) kept in the disk
shard as Pi's is.

The tests read the fixture sessions (testdata/grok): a's two turns (its
first spent by grok-4.7-build and grok-4.7-mini together, its second by
grok-4.7-build alone), a subagent's own folder counting its one turn as
its own, a fork counting only the turn written after its created_at,
and a session with no turn completed no calls, by ~/.grok and by
$GROK_HOME. They fail with no Grok calls on the old code.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/sessions/call_cache.go      |  11 +++
 internal/sessions/calls.go           |  20 +++--
 internal/sessions/calls_grok.go      | 111 +++++++++++++++++++++++++++
 internal/sessions/calls_grok_test.go |  97 +++++++++++++++++++++++
 4 files changed, 232 insertions(+), 7 deletions(-)
 create mode 100644 internal/sessions/calls_grok.go
 create mode 100644 internal/sessions/calls_grok_test.go

diff --git a/internal/sessions/call_cache.go b/internal/sessions/call_cache.go
index a0f5f351b..225701575 100644
--- a/internal/sessions/call_cache.go
+++ b/internal/sessions/call_cache.go
@@ -284,6 +284,7 @@ var lineCallReaders = map[string]lineCallReader{
 	"raft":  {piCallsBegin, readPiCallLine, piCallsKept},
 	"cindy": {piCallsBegin, readPiCallLine, piCallsKept},
 	"omp":   {piCallsBegin, readPiCallLine, piCallsKept},
+	"grok":  {grokCallsBegin, grokCallLine, grokCallsKept}, // #4423
 }
 
 // callLock is the lock a file's calls are read under, so that two readers
@@ -574,6 +575,10 @@ type callDiskState struct {
 	PiCwd               string
 	PiSince             time.Time
 	PiProvider, PiModel string
+	// Grok Build's carry (grokCallCarry), flat: GrokOn when there is one
+	GrokOn    bool
+	GrokSince time.Time
+	GrokModel string
 }
 
 func diskCallState(s *callFile) callDiskState {
@@ -586,6 +591,9 @@ func diskCallState(s *callFile) callDiskState {
 	if p := s.Pi; p != nil {
 		d.PiOn, d.PiHeader, d.PiCwd, d.PiSince, d.PiProvider, d.PiModel = true, p.Header, p.Cwd, p.Since, p.Provider, p.Model
 	}
+	if g := s.Grok; g != nil {
+		d.GrokOn, d.GrokSince, d.GrokModel = true, g.Since, g.Model
+	}
 	return d
 }
 func (s callDiskState) restore() *callFile {
@@ -601,6 +609,9 @@ func (s callDiskState) restore() *callFile {
 	if s.PiOn {
 		st.Pi = &piCarry{s.PiHeader, s.PiCwd, s.PiSince, s.PiProvider, s.PiModel}
 	}
+	if s.GrokOn {
+		st.Grok = &grokCallCarry{Since: s.GrokSince, Model: s.GrokModel}
+	}
 	return st
 }
 
diff --git a/internal/sessions/calls.go b/internal/sessions/calls.go
index 2fadc7a90..8547a3bc9 100644
--- a/internal/sessions/calls.go
+++ b/internal/sessions/calls.go
@@ -101,6 +101,8 @@ type callFile struct {
 	Pi *piCarry
 	// dsh
 	Dsh *dshCarry
+	// Grok Build
+	Grok *grokCallCarry
 }
 
 // cxRun is where a rollout's read stands: what its lines have said so far.
@@ -324,11 +326,11 @@ func callFileLists(codex []file) [][]file {
 // calls are rows of their database or their JSON files; and WorkBuddy's, whose usage lines repeat a reply's id as it
 // goes on, as CodeBuddy Code's do (#1779); and MiniMax Code's, whose messages
 // file a later generation of its history may replace (#1605). Kimi Code's
-// (#1607), Pi's and omp's (#1951) are lines of a file only appended to,
-// read on as callFiles' are; DeepSeek Harness's, a file only appended to
-// that may be packed in zstd frames, is read on from the frame it was
-// left in (readDshCalls). Every agent here needs an entry in
-// wholeCallReaders, lineCallReaders or resumeCallReaders.
+// (#1607), Pi's and omp's (#1951) and Grok Build's (#4423) are lines of a
+// file only appended to, read on as callFiles' are; DeepSeek Harness's, a
+// file only appended to that may be packed in zstd frames, is read on
+// from the frame it was left in (readDshCalls). Every agent here needs an
+// entry in wholeCallReaders, lineCallReaders or resumeCallReaders.
 func callSources() []file { return callSourcesWith(codexFiles()) }
 
 // callSourcesWith is callSources with codex the rollouts codexFiles found.
@@ -338,8 +340,8 @@ func callSourcesWith(codex []file) []file { return callSourcesInto(nil, codex) }
 func callSourcesInto(out []file, codex []file) []file {
 	lists := append(callFileLists(codex), openCodeCallFiles(), zcodeCallFiles(), dshCallFiles(),
 		minimaxCallFiles(), kimiCallFiles(), wslFiles("kimi"), piCallFiles(), codebuddyCallFiles(),
-		agyCallFiles(), // #2097
-		workbuddyCallFiles())
+		agyCallFiles(),                        // #2097
+		workbuddyCallFiles(), grokCallFiles()) // #4423
 	if out == nil {
 		return allowed(distinctOf(lists...))
 	}
@@ -443,6 +445,10 @@ func (st *callFile) cloneState() *callFile {
 		}
 		c.Dsh = &d
 	}
+	if st.Grok != nil {
+		g := *st.Grok
+		c.Grok = &g
+	}
 	return &c
 }
 
diff --git a/internal/sessions/calls_grok.go b/internal/sessions/calls_grok.go
new file mode 100644
index 000000000..a436f21c7
--- /dev/null
+++ b/internal/sessions/calls_grok.go
@@ -0,0 +1,111 @@
+package sessions
+
+import (
+	"bytes"
+	"cmp"
+	"encoding/json"
+	"path/filepath"
+	"time"
+)
+
+// Grok Build's own calls (#4423, liubing0806: its direct calls to x.ai
+// never reached Usage) — read from the same updates.jsonl the Sessions
+// page reads (parseGrok), each turn_completed's usage a call per model in
+// modelUsage, on that model's own counts (grokUsage.tokens: input without
+// what the cache held). An empty modelUsage is the session's model
+// (current_model_id, else "grok"). The turn's time is the line's. A
+// subagent's turns are in its own folder, a call of its own session. A
+// fork counts the lines written from its created_at on: what it copied
+// from its source is older, and was counted where it was first written.
+//
+// A call made through magpie's gateway is the gateway's to count; the
+// ledger matches these calls with its records as it does the others'
+// (gatewayMatches) and leaves the matched out of Local session. The
+// turn_completed lines carry no message id, so none is matched on.
+//
+// Grok Build only appends to updates.jsonl, a line an event, so a file
+// that grew is read on from where the last read left off
+// (lineCallReaders).
+
+// grokCallFiles are the session files Sessions lists for Grok Build
+// (grokFiles): one updates.jsonl per session folder, beside its
+// summary.json.
+func grokCallFiles() []file { return grokFiles() }
+
+// grokCallCarry is what a read of a session's updates carries on with:
+// what of its summary the turns are counted under.
+type grokCallCarry struct {
+	Since time.Time `json:"since,omitzero"`
+	Model string    `json:"model,omitempty"`
+}
+
+// grokCallsBegin starts a session's updates read from its start, with its
+// summary: the model an empty modelUsage falls back to, and, for a fork,
+// the time its source's lines were copied before.
+func grokCallsBegin(st *callFile, f file) {
+	st.Session = filepath.Base(filepath.Dir(f.path))
+	c := &grokCallCarry{}
+	if m, ok := readGrokSummary(f.m().manifest); ok {
+		c.Model = m.CurrentModel
+		if m.Parent != "" {
+			// what it copied from its source is older than it
+			if at, err := time.Parse(time.RFC3339Nano, m.CreatedAt); err == nil {
+				c.Since = at.Truncate(time.Second)
+			}
+		}
+	}
+	st.Grok = c
+}
+
+// grokCallsKept is whether st holds what reading on needs: a disk shard
+// written before the carry was kept there does not, and its file is read
+// whole again once it changes.
+func grokCallsKept(st *callFile) bool { return st.Grok != nil }
+
+// grokCallLine reads one line of a session's updates: a turn_completed
+// with usage is a call per model.
+func grokCallLine(st *callFile, b []byte) {
+	b = bytes.TrimSpace(b)
+	if len(b) == 0 || len(b) > maxLine || !bytes.Contains(b, grokTurn) {
+		return
+	}
+	at := numTS(b)
+	if at.IsZero() {
+		return
+	}
+	if c := st.Grok; c != nil && !c.Since.IsZero() && at.Before(c.Since) {
+		return
+	}
+	var l grokLine
+	if json.Unmarshal(b, &l) != nil {
+		return
+	}
+	u := l.Params.Update
+	if u.SessionUpdate != "turn_completed" || u.Usage == nil {
+		return
+	}
+	add := func(model string, u grokUsage) {
+		t := u.tokens()
+		if t.zero() {
+			return
+		}
+		st.Calls = append(st.Calls, Call{
+			Agent:   "grok",
+			Time:    at,
+			Session: st.Session,
+			Model:   st.str(model),
+			Tokens:  t,
+		})
+	}
+	if len(u.Usage.ModelUsage) == 0 {
+		var model string
+		if c := st.Grok; c != nil {
+			model = c.Model
+		}
+		add(cmp.Or(model, "grok"), u.Usage.grokUsage)
+		return
+	}
+	for name, mu := range u.Usage.ModelUsage {
+		add(name, mu)
+	}
+}
diff --git a/internal/sessions/calls_grok_test.go b/internal/sessions/calls_grok_test.go
new file mode 100644
index 000000000..a10e44148
--- /dev/null
+++ b/internal/sessions/calls_grok_test.go
@@ -0,0 +1,97 @@
+package sessions
+
+import (
+	"path/filepath"
+	"testing"
+	"time"
+)
+
+// #4423 (liubing0806): Grok Build's own calls reach Usage, read from the
+// same updates.jsonl the Sessions page reads (parseGrok). The four sessions
+// in testdata/grok:
+//
+//   - a: two turns, the first spent by grok-4.7-build and grok-4.7-mini
+//     together, the second by grok-4.7-build alone
+//   - b: a subagent's own folder (session_kind subagent), its one turn its
+//     own, not its parent a's
+//   - c: a fork of a, whose first turn is the copy of a's first one —
+//     counted where it was first written, so only its own turn (written
+//     after its created_at) is a call of its own
+//   - d: no turn completed, no calls
+type grokTotal struct{ n, input, cacheRead, cacheWrite, output int }
+
+func grokCallsBy(f func(Call) string) map[string]grokTotal {
+	out := map[string]grokTotal{}
+	for _, c := range Calls(time.Time{}) {
+		if c.Agent != "grok" {
+			continue
+		}
+		t := out[f(c)]
+		t.n, t.input, t.cacheRead, t.cacheWrite, t.output =
+			t.n+1, t.input+c.Input, t.cacheRead+c.CacheRead, t.cacheWrite+c.CacheWrite, t.output+c.Output
+		out[f(c)] = t
+	}
+	return out
+}
+
+func TestGrokCalls(t *testing.T) {
+	for _, viaEnv := range []bool{false, true} {
+		name := "~/.grok"
+		if viaEnv {
+			name = "GROK_HOME"
+		}
+		t.Run(name, func(t *testing.T) {
+			claude, _ := setup(t)
+			dir := filepath.Join(filepath.Dir(claude), "home", ".grok")
+			copyTree(t, "testdata/grok", dir)
+			if viaEnv {
+				t.Setenv("GROK_HOME", dir)
+			}
+			want := map[string]grokTotal{
+				"0190aaaa-0000-7000-8000-00000000000a": {3, 800, 2800, 0, 110},
+				"0190aaaa-0000-7000-8000-00000000000b": {1, 200, 100, 0, 20},
+				"0190aaaa-0000-7000-8000-00000000000c": {1, 100, 300, 0, 30},
+			}
+			got := grokCallsBy(func(c Call) string { return c.Session })
+			if len(got) != len(want) {
+				t.Fatalf("sessions with calls %v, want %v", got, want)
+			}
+			for s, w := range want {
+				if got[s] != w {
+					t.Fatalf("session %s calls %+v, want %+v", s, got[s], w)
+				}
+			}
+			// the Usage ledger lists them by model
+			byModel := grokCallsBy(func(c Call) string { return c.Model })
+			wantModels := map[string]grokTotal{
+				"grok-4.7-build": {3, 800, 3100, 0, 130},
+				"grok-4.7-mini":  {2, 300, 100, 0, 30},
+			}
+			for m, w := range wantModels {
+				if byModel[m] != w {
+					t.Fatalf("model %s calls %+v, want %+v", m, byModel[m], w)
+				}
+			}
+			if len(byModel) != len(wantModels) {
+				t.Fatalf("models %v, want %v", byModel, wantModels)
+			}
+		})
+	}
+}
+
+// A fork counts only its own turns: c's call is its turn of 09:00:30, not
+// the copied one of 08:00:20.
+func TestGrokCallsForkKeepsItsOwnTurns(t *testing.T) {
+	claude, _ := setup(t)
+	dir := filepath.Join(filepath.Dir(claude), "home", ".grok")
+	copyTree(t, "testdata/grok", dir)
+	var got []int64
+	for _, c := range Calls(time.Time{}) {
+		if c.Agent == "grok" && c.Session == "0190aaaa-0000-7000-8000-00000000000c" {
+			got = append(got, c.Time.Unix())
+		}
+	}
+	if len(got) != 1 || got[0] != 1790499630 {
+		t.Fatalf("fork c call times %v, want [1790499630]", got)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [fix/4423-grok-usage-local](https://github.com/ggbdpq/magpie/tree/fix/4423-grok-usage-local) (head `9c545e469429f818081e1ee7291ebb782410fcb7`).
