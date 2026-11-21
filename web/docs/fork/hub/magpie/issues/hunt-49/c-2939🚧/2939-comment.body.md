The data in this report makes the size of the gap clear — thank you for counting it: 7,761 429s in one day, 18 of them the vendor's. This patch takes the lowest-cost fix you asked for (your priority 1) and nothing more: the routing trace's try record now says whose the 429 was. It is observability only — the agent's answer is byte-for-byte what it was (same 429, same `Retry-After`, same message), because changing the status or the wording sent to clients is a behavior change and the maintainer's call; your points 2 (per-model `maxConcurrency`) and 3 (the "its" wording) remain open for that decision.

Branch: [`hunt49-c-maxconc-429`](https://github.com/ggbdpq/magpie/tree/hunt49-c-maxconc-429), one commit on top of upstream `79160455`; the patch below applies with `git am`.

## What changed

- `internal/gateway/routing.go`: one new fail reason beside the existing ones — `failLocal = "local"`, for a try magpie itself turned away at one of its own gates (queue full under `QueueLimit`, waited out under `QueueWait`, or no room in the minute under `MaxRPM`) before anything went to the vendor.
- `internal/gateway/gateway.go`: the trace update for such a turn-away — the one that already wrote `status`, `error`, `queued` and `ms` on the try — now also sets `fail: "local"`. That is the whole product change; three added lines.
- A consumer of `routing/<date>.jsonl` can now separate the two 429s with one field: a vendor's refusal carries what its body called the failure (`fail: "quota"`, `"rate"`, …) and usually `rest`; a local turn-away carries `fail: "local"` and no `rest`. Before, both read as a bare `status: 429` and only the wording of `error` told them apart — exactly your pain 1.
- `usage.jsonl` needed no change: its rows for a lane turn-away have carried `rejected: true` since before this issue (the write goes through the same `logged()` as every turn-away before a provider is asked), so there the two were already separable.

## Red before the fix

`TestLocalTurnAwayIsMarkedInItsTry` (new): a provider at `MaxConcurrency: 1, QueueLimit: 1, QueueWait: 1`, three requests — one at the vendor, one queued, one more than the queue holds. On current code it failed exactly as the issue describes:

```
try "slow" (slow: 1 requests at once is its limit, and this one waited 1.0s for a free slot, ...) = fail "", want "local"
```

The same test also pins the wire shape as unchanged: the turned-away client gets the same immediate 429, OpenAI-shaped body with its `error.type`, and `Retry-After` as before — asserted before the marker is.

## Verification

| Check | Result |
| --- | --- |
| New test on current code (RED) | fail `""` vs `"local"` — failed as expected |
| New test + neighbors after the fix | ok |
| Full `internal/gateway` package (`go test ./internal/gateway/ -count=1`) | ok, 318.6s, 0 failures |
| Targeted turn-away tests with `-race` | ok |
| `gofmt -l internal/gateway/` | clean |
| `go vet` darwin / linux / windows | clean |
| `go build` darwin / windows | ok (pre-existing linker warnings only) |
| `go build` linux (whole binary) | fails in `wails/v3@v3.0.0-beta.24` itself (`undefined: pointer` in its `menu_linux.go`) — pre-existing on this machine, untouched by this diff (it changes only `internal/gateway`); `go build ./internal/gateway/` for linux and windows passes |
| Ablation (product change reverted, test kept) | red: `fail ""` again |
| Mutation a (marker dropped) | red: `fail ""` |
| Mutation b (client status changed to 503 — the over-reach) | red on the unchanged-shape assertion |

## Siblings

- Gateway-key limits (`keyLimited`): already distinguished — their usage rows carry `rejected: true` with `err_type: "gateway_key_limit"`, plus the `X-Magpie-Limit-Reset` header. Nothing needed.
- The RPM limiter flows through the same turn-away branch as the queue, so its tries now read `fail: "local"` too; its `Retry-After` already says when the minute has room and its `error` text reads differently. A separate reason (say `"rpm"`) would be one more line if you want the two gates apart in SQL as well.
- The Routing page maps known `fail` values to words and falls back to a generic label for unknown ones, so `"local"` renders safely today; a phrase of its own would be a small GUI follow-up.

## Not verified

Your workload is not reproduced: this is verified with a fixture (one slow vendor, one slot, one queue place), not against a 22-provider free pool. The counts of chained rejections across models (your pain 2) and the never-challenged `maxConcurrency` default (your pain 3's evidence) are untouched by this patch — per-model granularity is a real feature request worth its own issue.

**AI**: written with an AI coding agent; I've read the whole diff and can answer questions on it myself. The model name is in the commit's trailer.
**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.

<details><summary>patch (git am): 0001-gateway-a-local-concurrency-rejection-is-recorded-as.patch — sha256 e9f1bcd7533de634</summary>

```patch
From f52f6382572d396dc54b553eb2768ca0df196df4 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 20 Oct 2026 05:29:14 +0800
Subject: [PATCH] gateway: a local concurrency rejection is recorded as its own
 failure, not a vendor 429 (#2939)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A try magpie itself turns away — its key's or account's queue full
(QueueLimit), or one that waited QueueWait for a free slot, or no room
in the minute under MaxRPM — is told to the agent as a 429 exactly as a
vendor's rate limit is, and its routing trace try said nothing about
whose it was: fail was left empty, where a vendor's failure carries its
reason (fail "quota", "rate" …) and, when it rests, rest. A reader of
routing/<date>.jsonl could only tell them apart by the wording of the
error text. Now the trace update sets fail "local" on such a try, a new
reason beside the others, so one field separates magpie's own gate from
the vendor's. The agent's answer is untouched: same 429, same Retry-After,
same message.

Why: #2939 counts a day's routing log on a free pool — 7,761 429s, of
which 18 were the vendor's and the rest magpie's own concurrency gate —
and the two call for opposite handling (wait for the vendor's reset;
retry in seconds past a full local queue).

Run: TestLocalTurnAwayIsMarkedInItsTry (red before the fix: fail "");
the queue, lane and ledger tests around it; the full gateway package
(ok, 318s); -race on the turn-away tests; gofmt; go vet and builds on
darwin, linux and windows.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/gateway.go              |  3 +
 internal/gateway/lane_local_fail_test.go | 83 ++++++++++++++++++++++++
 internal/gateway/routing.go              |  8 +++
 3 files changed, 94 insertions(+)
 create mode 100644 internal/gateway/lane_local_fail_test.go

diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index dcd6568d..dd18f9d7 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -2709,2 +2709,5 @@ func (s *Server) serve(w http.ResponseWriter, r *http.Request, from provider.Pro
 				tt.Done, tt.Status, tt.Error, tt.Queued, tt.Millis = true, call.Status, call.Error, queued, time.Since(began).Milliseconds()
+				// whose 429 this was: magpie's own gate, not the vendor's,
+				// with nothing sent (#2939)
+				tt.Fail = failLocal
 			})
diff --git a/internal/gateway/lane_local_fail_test.go b/internal/gateway/lane_local_fail_test.go
new file mode 100644
index 00000000..96a91292
--- /dev/null
+++ b/internal/gateway/lane_local_fail_test.go
@@ -0,0 +1,83 @@
+package gateway
+
+import (
+	"context"
+	"encoding/json"
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// A try magpie itself turned away — its key's or account's queue full
+// (QueueLimit), or one that waited QueueWait for a slot — is told to the
+// agent as a 429 exactly as a vendor's rate limit is, and its routing
+// trace try now says whose it was: fail "local", where a vendor's 429
+// carries what its body called the failure (fail "quota", "rate" …) or,
+// on the last try, nothing at all. The agent's answer is unchanged
+// (#2939: a day's routing log held 7,761 429s, 18 of them the vendor's).
+func TestLocalTurnAwayIsMarkedInItsTry(t *testing.T) {
+	fresh(t)
+	v, up := slowUp(t)
+	one := 1
+	if err := provider.Save(provider.Provider{ID: "slow", Name: "Slow", Key: "k", Models: []string{"m"}, Chat: up + "/v1",
+		MaxConcurrency: &one, QueueLimit: 1, QueueWait: 1}); err != nil {
+		t.Fatal(err)
+	}
+	g := newLaneRig(t)
+	lane := func() Lane { return g.s.Lanes()["slow#"+provider.KeyID("k")] }
+
+	g.send(context.Background(), "/v1/chat/completions", "slow/m", "a")
+	within(t, "a at the vendor", func() bool { return len(v.seen()) == 1 })
+	g.send(context.Background(), "/v1/chat/completions", "slow/m", "b")
+	within(t, "b queued", func() bool { return lane().Waiting == 1 })
+
+	// the queue full: c turned away at once, the agent's 429 as it has
+	// always been — OpenAI's shape, its type, Retry-After — and the
+	// vendor never asked
+	g.send(context.Background(), "/v1/chat/completions", "slow/m", "c")
+	r := g.reply()
+	if r.tag != "c" || r.status != 429 || r.header.Get("Retry-After") == "" {
+		t.Fatalf("c = %+v, want the usual immediate 429 with Retry-After", r)
+	}
+	var oe struct {
+		Error struct {
+			Message, Type string
+		} `json:"error"`
+	}
+	if json.Unmarshal([]byte(r.body), &oe) != nil || oe.Error.Type == "" || !strings.Contains(oe.Error.Message, "queue is full") {
+		t.Fatalf("c's body = %s, want the same OpenAI-shaped 429 as ever", r.body)
+	}
+
+	// b waited its QueueWait and is turned away too
+	r = g.reply()
+	if r.tag != "b" || r.status != 429 || !strings.Contains(r.body, "waited") {
+		t.Fatalf("b = %+v, want the usual 429 for waiting too long", r)
+	}
+
+	// the routing trace says both tries were magpie's own turn-aways,
+	// not the vendor's: fail "local" on each, the 429 they carry unchanged
+	marked := 0
+	for _, rt := range g.s.Trace(context.Background(), 0, 0).Routes {
+		for _, tr := range rt.Tries {
+			if tr.Status != 429 {
+				continue
+			}
+			if strings.Contains(tr.Error, "queue is full") || strings.Contains(tr.Error, "waited") {
+				if tr.Fail != "local" {
+					t.Fatalf("try %q (%s) = fail %q, want \"local\"", tr.ID, tr.Error, tr.Fail)
+				}
+				marked++
+			}
+		}
+	}
+	if marked != 2 {
+		t.Fatalf("%d turn-away tries in the trace, want 2", marked)
+	}
+
+	close(v.gate("a"))
+	if r := g.reply(); r.tag != "a" || !strings.Contains(r.body, "[DONE]") {
+		t.Fatalf("a = %+v", r)
+	}
+	within(t, "every slot given back", func() bool { return len(g.s.Lanes()) == 0 })
+}
diff --git a/internal/gateway/routing.go b/internal/gateway/routing.go
index 6929fdd8..b15e99eb 100644
--- a/internal/gateway/routing.go
+++ b/internal/gateway/routing.go
@@ -300,2 +300,10 @@ const (
 	failRestricted = "restricted"
+	// failLocal: magpie itself turned the try away at one of its own gates
+	// — its key's or account's queue was full (QueueLimit) or it waited as
+	// long as it may (QueueWait), or its MaxRPM has no room in the minute —
+	// before anything went to the vendor. The agent is told 429 as for a
+	// vendor's, and nobody rests; this says whose the 429 was (#2939: a
+	// day's routing log held 7,761 429s, 18 of them the vendor's, and
+	// nothing but the wording told them apart)
+	failLocal = "local"
 )
-- 
2.50.1 (Apple Git-155)

```

</details>
