The reporter's A/B table is the finding: `claude -p --effort low` vs `--effort max` gave 325 vs 1002 output tokens (4.8s vs 9.1s), while the same two efforts through the gateway's `/v1/messages` (`output_config.effort`) were indistinguishable (~9s both, 433 vs 394 tokens) — and sampling the spawned `claude -p` showed no `--effort` on its command line and no effort variable in its environment.

On current main (`ef655acb`) I verified where it is lost. The bridge's argument builder already appends `--effort <level>` for any request that carries an effort (`claudeCLIArgs`, `internal/gateway/claude_subscription.go:1934-1937`, present in v0.1.1290 too) — the flag was never dropped at spawn. What drops it is one step earlier: the Anthropic request parse reads `output_config.effort` only when the request also asks thinking with type `enabled`/`adaptive` (`parseAnthropicRequest`, `internal/gateway/anthropic.go:241-251`). A request that names an effort and no thinking ask reaches the bridge with no effort, so no `--effort` is appended — the reporter's sample. (The OpenAI-compatible route already passes `reasoning_effort` through unconditionally, `parseChat`, `internal/gateway/chat.go:84`, so that half of the expected behavior held.)

The fix is bridge-scoped: `serveSubscription` now takes the effort the request's `output_config` names even when the parse left none, unless the request turned thinking off (`internal/gateway/claude_subscription.go:4053-4062`, via `outputConfigEffort`, `internal/gateway/decide.go:665-676`). The parse gate stands for every other backend, where honoring a thinking-less effort would turn thinking on upstream that the request never asked for (Claude Code's own title requests carry an effort and no thinking); through the bridge the level is `--effort`, which needs no thinking ask. A request with no effort spawns exactly as before, and a turn resumed in a kept run is told the level as before (`setEffort`, reached whenever the request's effort differs from the run's).

Branch: [`hunt47-e-bridge-effort`](https://github.com/ggbdpq/magpie/tree/hunt47-e-bridge-effort), one commit on top of upstream `ef655acb`; the patch below applies with `git am`.

## What changed

- `internal/gateway/claude_subscription.go:4053-4062` — in `serveSubscription`, after the request is parsed: for an Anthropic-protocol request whose parse left `req.Effort` empty and that did not turn thinking off (`req.ThinkOff`), the effort `output_config.effort` names is taken for the bridge. Both consumers see it: a new run is spawned with `--effort <level>` (`claudeCLIArgs`, line 1934), and a turn resumed in a waiting run is told the level (`setEffort`).
- `internal/gateway/decide.go:665-676` — `outputConfigEffort`: the effort an Anthropic body's `output_config` names, normalized through the same `effortOf` the parse uses (so `minimal`/`none` map to `low`, `ultra` to `max`, as elsewhere), `""` when it names none or the body does not decode.
- `internal/gateway/claude_effort_test.go` (new) — `TestClaudeBridgePassesTheRequestsEffort`, at the bridge's HTTP seam (`serveClaudeSubscription`) with a script standing in for Claude Code.

## Red before the fix

`TestClaudeBridgePassesTheRequestsEffort` on code without the change:

```
--- FAIL: TestClaudeBridgePassesTheRequestsEffort (0.74s)
    claude_effort_test.go:61: output_config.effort max: no --effort max in
    "-p --output-format stream-json ... --model claude-opus-5-5 ...
    --setting-sources  --dangerously-skip-permissions"
```

the recorded command line of the spawned process for a `/v1/messages` body carrying `"output_config":{"effort":"max"}` and no thinking ask — the reporter's observation, reproduced. The other two assertions of the same test were already true before the change: an effort asked with `thinking.enabled` reached the CLI (`--effort high`), and a request with no effort spawned with no `--effort`.

Ablation and mutation, on the finished patch (test kept, product files swapped):

- Reverting only the `serveSubscription` hunk to upstream's → FAIL again. Reverting only `decide.go` → build fails (`undefined: outputConfigEffort`). Restored → PASS.
- Mutation (a), append dropped → FAIL. Mutation (b), `--effort` appended unconditionally → FAIL at `claude_effort_test.go:73: no effort asked: --effort in ...`. Restored → PASS.

## Verification

| Check | Command | Result |
|---|---|---|
| New test, old code | `go test ./internal/gateway/ -run TestClaudeBridgePassesTheRequestsEffort -count=1` (before the fix) | FAIL (above) |
| New test, fixed | same | PASS |
| Claude bridge family | `go test ./internal/gateway/ -run TestClaude -count=1` | ok 33.3s |
| Effort suites | `go test ./internal/gateway/ -run 'Effort\|effort' -count=1 -v` | 40 tests PASS |
| Full package | `go test ./internal/gateway/ -count=1` | ok 341.9s |
| Race | `go test -race ./internal/gateway/ -run TestClaude -count=1` | ok 40.5s |
| gofmt | `gofmt -l` on the three touched files | clean |
| vet | `go vet ./internal/gateway/` (darwin, `GOOS=linux`, `GOOS=windows`) | pass |
| Builds | `go build -tags nogui .` (darwin), `GOOS=linux CGO_ENABLED=0`, `GOOS=windows CGO_ENABLED=0` | pass (a pre-existing cgo `-Wenum-conversion` warning in `internal/gui/trayimage_darwin.go:112`, not from this patch) |

## Siblings

What else the bridge hands the CLI at spawn, unchanged: `--model` (the picked model), `--tools` (its WebSearch when the client offered one), `--mcp-config`/`--strict-mcp-config`, `--setting-sources`, `--dangerously-skip-permissions`, `--no-session-persistence`; conditionally `--system-prompt-file` (lean prompt), `--thinking disabled` (the client turned thinking off — which still suppresses the effort here, as it did), `--json-schema` (structured output), `--resume` (a saved session); in its environment `cleanClaudeEnv`'s pins, the account's proxy, `ANTHROPIC_BETAS`, `DISABLE_PROMPT_CACHING`.

What else consumes `output_config.effort`, untouched: the parse gate itself (`anthropic.go:241-251`) and `requestEffort` (`decide.go:643`), which keep honoring it only beside a thinking ask — every other backend is served from the same parsed `Request`, where a bare effort becomes `reasoning_effort` or an upstream thinking block (`chat.go:499-503`, `anthropic.go:916-944`) and would switch thinking on for requests that never asked for it; and `withOutputEffort` (`anthropic.go:764`), which writes the effort into an outgoing Anthropic body, fitted to the model's levels. A kept run's level for its next turn was already told to the running CLI (`setEffort`, the `apply_flag_settings` control request), so the fix reaches resumed turns through existing machinery, and the effort counts in the run-reuse keys (`turnKey`, `newLooseTurn`) exactly as an effort-with-thinking request's does.

## Not verified

- No Claude Code subscription account here: every run in this patch's tests is a shell script standing in for the CLI, and nothing was asked of Anthropic. The spawned process is captured verbatim (the fake records `"${@}"`), but what the real CLI does with `--effort` at 2.1.303 is not exercised.
- That the CLI takes `--effort low`/`--effort max` and that they change the reply rests on the reporter's A/B table, not on a vendor document. (magpie's own #385 record says Claude Code 2.1.286 takes low, medium, high, xhigh and max — consistent, but still not a vendor doc.)
- Levels beyond low/max are not tested against a real CLI; on magpie's side every level passes through as the request named it (`claudeCLIArgs` unit test covers all five).
- `magpie model efforts` offering levels for `claude/claude-opus-5-5` (the issue's premise) was not re-derived here; the fix does not fit or filter the level against the model's catalog — it passes what the request named, as the CLI does.

**AI**: written with an AI coding agent; I've read the whole diff and can answer questions on it myself. The model name is in the commit's trailer.

**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.

<details><summary>patch (git am, one commit on ef655acb)</summary>

```patch
From 091ca01d6d6725a8b0bb5605fef7b3c2197e2c64 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 20 Oct 2026 00:11:11 +0800
Subject: [PATCH] gateway: the Claude bridge passes the request's effort to the
 CLI it spawns (#2899)

A request for a Claude Code subscription could name its effort in
output_config.effort and the bridge still ran Claude Code at the CLI's own
level: parseAnthropic reads output_config.effort only when the request asks
thinking with it, so a request carrying an effort and no thinking ask
reached serveSubscription with no effort, and the --effort its
claudeCLIArgs appends for one was never appended. The reporter sampled the
spawned claude -p and found no --effort on its command line and no effort
variable in its environment, while their A/B table has the CLI's own
--effort low and --effort max at 325 and 1002 output tokens and the same
efforts through the gateway indistinguishable (~9s either way).

serveSubscription now takes the effort an Anthropic request's
output_config names even when its parse left none (outputConfigEffort),
unless the request turned thinking off. The gate that keeps a thinking-less
effort from turning thinking on upstream still stands for every other
backend: through the bridge the level is --effort, which works whatever
the turn thinks of. A request with no effort spawns as it did, and a turn
resumed in a run waiting for it is told the level as before (setEffort).

TestClaudeBridgePassesTheRequestsEffort stands in for Claude Code with a
script that records the arguments it is spawned with, and fails on the old
code: output_config.effort max came through with no --effort on the
recorded command line. With the change it reads --effort max, a request
that asks its effort with thinking reads it as it always did, and a
request that asks no effort spawns with no --effort.

go test ./internal/gateway/ -count=1 (full package, 341.9s), -run TestClaude
(33.3s), -race -run TestClaude (40.5s), go vet (darwin, GOOS=linux,
GOOS=windows), gofmt and go build -tags nogui (darwin, GOOS=linux,
GOOS=windows) pass.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/claude_effort_test.go  | 75 +++++++++++++++++++++++++
 internal/gateway/claude_subscription.go | 10 ++++
 internal/gateway/decide.go              | 14 +++++
 3 files changed, 99 insertions(+)
 create mode 100644 internal/gateway/claude_effort_test.go

diff --git a/internal/gateway/claude_effort_test.go b/internal/gateway/claude_effort_test.go
new file mode 100644
index 00000000..ed461b24
--- /dev/null
+++ b/internal/gateway/claude_effort_test.go
@@ -0,0 +1,75 @@
+package gateway
+
+import (
+	"net/http/httptest"
+	"os"
+	"path/filepath"
+	"runtime"
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+	"github.com/yetone/magpie/internal/testenv"
+)
+
+// TestClaudeBridgePassesTheRequestsEffort: the effort a request carries is
+// the level the spawned Claude Code thinks at (--effort), also when the
+// request asks no thinking with it (#2899: output_config.effort low and max
+// reached the subscription as the same turn, with no --effort on the spawned
+// command line).
+func TestClaudeBridgePassesTheRequestsEffort(t *testing.T) {
+	if runtime.GOOS == "windows" {
+		t.Skip("a shell script stands in for Claude Code")
+	}
+	testenv.SetHome(t, t.TempDir())
+	t.Setenv("TMPDIR", t.TempDir())
+	dir := t.TempDir()
+	script := `#!/bin/sh
+printf '%s\n' "$@" > ` + dir + `/args
+while read -r line; do
+  echo '{"type":"stream_event","event":{"type":"message_start","message":{"id":"m","model":"claude-opus-5-5","usage":{"input_tokens":1}}}}'
+  echo '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}}'
+  echo '{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}}'
+  echo '{"type":"stream_event","event":{"type":"message_stop"}}'
+  echo '{"type":"result","subtype":"success","is_error":false,"result":""}'
+done
+`
+	testenv.Program(t, filepath.Join(dir, "claude"), script)
+	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
+
+	s := New()
+	t.Cleanup(s.subscription.abortAll)
+	p := provider.Provider{ID: "claude", Account: &provider.Account{Agent: "claude", User: "u"}}
+	post := func(body string) string {
+		t.Helper()
+		rec := httptest.NewRecorder()
+		var u Usage
+		if code, msg := s.serveClaudeSubscription(rec, httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body)), provider.Anthropic, p, "claude-opus-5-5", []byte(body), &u); code != 200 {
+			t.Fatalf("%d %s", code, msg)
+		}
+		b, err := os.ReadFile(filepath.Join(dir, "args"))
+		if err != nil {
+			t.Fatal(err)
+		}
+		// the fake writes one argument a line; the command line is them
+		// joined, which is what the assertions below read
+		return strings.Join(strings.Fields(string(b)), " ")
+	}
+
+	// the effort an output_config names, thinking asked or not, is the
+	// spawned Claude Code's
+	args := post(`{"model":"claude-opus-5-5","max_tokens":100,"output_config":{"effort":"max"},"messages":[{"role":"user","content":"How many positive integers below 100000 have digits that sum to 23?"}]}`)
+	if !strings.Contains(args, "--effort max") {
+		t.Fatalf("output_config.effort max: no --effort max in %q", args)
+	}
+	// with the thinking ask, as it always was
+	args = post(`{"model":"claude-opus-5-5","max_tokens":100,"thinking":{"type":"enabled","budget_tokens":1024},"output_config":{"effort":"high"},"messages":[{"role":"user","content":"and now?"}]}`)
+	if !strings.Contains(args, "--effort high") {
+		t.Fatalf("output_config.effort high with thinking: no --effort high in %q", args)
+	}
+	// no effort asked, no flag: the CLI's own level stands
+	args = post(`{"model":"claude-opus-5-5","max_tokens":100,"messages":[{"role":"user","content":"one more"}]}`)
+	if strings.Contains(args, "--effort") {
+		t.Fatalf("no effort asked: --effort in %q", args)
+	}
+}
diff --git a/internal/gateway/claude_subscription.go b/internal/gateway/claude_subscription.go
index 0532121e..a9f3a47a 100644
--- a/internal/gateway/claude_subscription.go
+++ b/internal/gateway/claude_subscription.go
@@ -4050,6 +4050,16 @@ func (s *Server) serveSubscription(w http.ResponseWriter, r *http.Request, from
 	if err != nil {
 		return writeError(w, from, 400, err.Error()), err.Error()
 	}
+	// output_config's effort is the level the CLI thinks at (--effort), which
+	// works whatever the turn thinks: taken also when the request asks no
+	// thinking, which upstream a reasoning ask would turn on though the
+	// request never asked for it (Claude Code's title requests carry an
+	// effort and no thinking) (#2899)
+	if from == provider.Anthropic && req.Effort == "" && !req.ThinkOff {
+		if e := outputConfigEffort(body); e != "" {
+			req.Effort = e
+		}
+	}
 	req.Model = model
 	if req.clientCache != nil {
 		req.clientCache.report = func() { cacheReportReady(w, req) }
diff --git a/internal/gateway/decide.go b/internal/gateway/decide.go
index ab5cf659..3d1262d0 100644
--- a/internal/gateway/decide.go
+++ b/internal/gateway/decide.go
@@ -662,6 +662,20 @@ func requestEffort(proto provider.Protocol, body []byte) string {
 	return effortOfBudget(v.Thinking.Budget)
 }
 
+// outputConfigEffort is the effort an Anthropic request's output_config
+// names, whatever it asks of thinking; "" when it names none.
+func outputConfigEffort(body []byte) string {
+	var v struct {
+		OutputConfig struct {
+			Effort string `json:"effort"`
+		} `json:"output_config"`
+	}
+	if decodeJSON(body, &v) != nil {
+		return ""
+	}
+	return effortOf(v.OutputConfig.Effort)
+}
+
 // sentEffort is the reasoning a request goes to model at: what it asks
 // for, fitted to the model's levels as it is fitted on the way out.
 func sentEffort(proto provider.Protocol, body []byte, p provider.Provider, model string) string {
-- 
2.50.1 (Apple Git-155)
```

</details>
