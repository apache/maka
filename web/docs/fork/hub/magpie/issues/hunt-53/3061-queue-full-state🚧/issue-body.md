Judges "immediate" by the lane's state, not the wall clock (#3061)

## Summary

`TestQueueFullAndWaitedOut` held c's 429 to a wall-clock bound (`time.Since(began) > 900*time.Millisecond`); under a full-suite run at load ~380 that bound failed while the reply itself was right (429, Retry-After, "queue is full"). The fix replaces the bound with the state the issue points at: when c's 429 is in hand, b is still in the queue (the lane's `Waiting` still 1) and the vendor has been asked once, for a alone. Test-only; no product code changes.

## Cause

The 900ms bound was the test's stand-in for "c was turned away before b's one-second `QueueWait` ran out" — the thing that distinguishes "the queue is full, rejected at once" from "c waited for b's slot". Wall time measures the machine as much as the code: on the maintainer's run the whole path from `began` to the reply read crossed 900ms under load ~380, so the check failed even though the gateway's behavior (the reply's status, header and body) was exactly right.

## Fix

The bound becomes two state reads right after c's reply is read: `lane().Waiting != 1` fails unless b is still queued, and `len(v.seen()) != 1` fails unless the vendor has been asked only for a. This is equivalent to "immediate" for what the test verifies: b's `QueueWait` starts when b is enqueued, so holding c's 429 while b is still queued means c did not wait for b to leave; the vendor asked once means c never reached it. `Discrimination`: with a 1.2s delay injected before c's reply is read (b has already waited out of the queue), the new check fails with `lane after c = {Busy:1 Waiting:0 Limit:1}, want b still in the queue when c's 429 arrived` — and if that check is itself neutralized to never fail, the same 1.2s delay still fails the test downstream at d's queue-full check (`d = 429 ... this one waited 1.0s for a free slot`): b leaving the queue gives d a queue slot, so the scenario's later assertions keep their teeth too.

## Verification

All on `318697dc` + this commit, macOS arm64, `GOTOOLCHAIN=auto`.
| Check | Command | Result |
|---|---|---|
| Targeted | `go test ./internal/gateway/ -run TestQueueFullAndWaitedOut -count=10` | ok, 10/10 |
| Race | `go test -race ./internal/gateway/ -run TestQueueFullAndWaitedOut -count=3` | ok |
| Under load | 4× `yes > /dev/null` on top, `-count=20` (12-core arm64 Mac, load ~4-6) | ok, 20/20 |
| Whole package | `go test ./internal/gateway/ -count=1 -p 1 -timeout 30m` | ok, 355s, 0 failures |
| Format | `gofmt -l internal/gateway/concurrency_account_test.go` | empty |
| Vet | `go vet ./internal/gateway/` | clean |
| Build | `go build` darwin/arm64; `GOOS=linux GOARCH=amd64 go build -tags nogui`; `GOOS=windows GOARCH=amd64 go build -tags nogui` | all fine |

## Not verified

The actual load-~380 full-suite environment from the issue is not reproducible here; the simulated load (4 busy loops, load ~4-6 on 12 cores) is far milder than ~380, so the fix's robustness at that extreme is argued by the mechanism (state read, no clock), not measured at that load. The branch is not pushed, so CI on it is not run either.

---
**Source**: the maintainer's full-suite run in #3061 (load ~380); the mechanism is confirmed by injecting a delay before c's reply is read, as the issue suggests, not by rerunning.

**Red without the fix** (base `318697dc`): with the test's wall-clock bound kept and a 950ms delay injected before c's reply is read, `go test ./internal/gateway -run TestQueueFullAndWaitedOut` fails:
```
    concurrency_account_test.go:170: c = {tag:c body:{"error":{"code":null,"message":"slow: 1 requests at once is its limit, and its queue is full (1 waiting); try again shortly","param":null,"type":"rate_limit_error"}}
         status:429 header:map[Content-Length:[167] Content-Type:[application/json] Date:[Tue, 20 Oct 2026 15:49:46 GMT] Retry-After:[1]] err:<nil>}, want an immediate 429 with Retry-After
--- FAIL: TestQueueFullAndWaitedOut (1.07s)
```
With the fix: `ok` — and with a 1.2s delay (b already out of the queue) the new state check fails as it should: `concurrency_account_test.go:175: lane after c = {Busy:1 Waiting:0 Limit:1}, want b still in the queue when c's 429 arrived`.

**Siblings**: within the lane/queue family this was the only wall-clock bound — `TestAccountLimitSharedAcrossGroups`, `TestLaneReleasedOnFailure` and `TestFullMemberGivesWay` judge by `within` polling only (plus one 50ms settle sleep at `concurrency_account_test.go:303`, a propagation delay rather than a bound; left as is). Other wall-clock bounds exist in the package but belong to other mechanisms and are left for a separate look: `overload_test.go:122` (`> 3*time.Second`, Retry-After patience — the nearest cousin), `rpm_test.go:526` (`> rpmWindow/2`), `classify_test.go:292,485`, `first_token_test.go:63,132`, `retry_test.go:246`, `upstream_h2_silent_test.go:176`, `stream_error_open_test.go:93`.

**When the read fails**: `lane()` reads `Server.Lanes()` (internal/gateway/concurrency.go:268), which builds a fresh map; a missing key yields the zero value `Lane{}`, so the new check fails with a printed `{Busy:0 Waiting:0 Limit:0}` rather than panicking.

**Not verified**: the maintainer's load-~380 machine (not reproducible locally; simulated load was load ~4-6 on 12 cores); CI on the branch (not pushed).

Branch with the commit: [hunt53-h-queue-full-state](https://github.com/ggbdpq/magpie/tree/hunt53-h-queue-full-state) (head `19cd883b5`).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: gateway: TestQueueFullAndWaitedOut judges "immediate" by the lane's state, not the wall clock (#3061) — git am applies it as is; SHA-256 first 16: 020c64ae0f6ec81f</summary>

```patch
From 19cd883b5e34945e2879a09d522e6cd43c5844ad Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 21 Oct 2026 00:04:47 +0800
Subject: [PATCH] gateway: TestQueueFullAndWaitedOut judges "immediate" by the
 lane's state, not the wall clock (#3061)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: the test's check that c is turned away at once held
c's reply to a wall-clock bound (arrived within 900ms); under a full
-suite run at load ~380 that bound failed while the reply itself was
right (429, Retry-After, "queue is full"). The bound is replaced by
the state the maintainer pointed at: when c's 429 is in hand, b is
still in the queue (the lane's Waiting is 1 — c was answered before
b's one-second QueueWait ran out) and the vendor has been asked once,
for a alone (c never reached it). No product code changes.

Run: go test ./internal/gateway/ -run TestQueueFullAndWaitedOut
-count=10 and -race -count=3 pass; -count=20 passes with four busy
loops loaded on top (12-core arm64 Mac, load ~4-6). The red is
reproduced the way the issue suggests, by delaying the read of c's
reply 950ms on the pre-fix test (the wall-clock bound fails with the
same message as in the issue), and the new state check still has
teeth: with a 1.2s delay b has already waited out of the queue and
the check fails with "want b still in the queue". gofmt clean, go vet
clean, go build (darwin/arm64, linux/amd64 -tags nogui,
windows/amd64 -tags nogui) fine.

Fixes #3061

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/concurrency_account_test.go | 12 ++++++++++--
 1 file changed, 10 insertions(+), 2 deletions(-)

diff --git a/internal/gateway/concurrency_account_test.go b/internal/gateway/concurrency_account_test.go
index 4c5d0f48..22473e40 100644
--- a/internal/gateway/concurrency_account_test.go
+++ b/internal/gateway/concurrency_account_test.go
@@ -162,12 +162,20 @@ func TestQueueFullAndWaitedOut(t *testing.T) {
 	within(t, "b queued", func() bool { return lane().Waiting == 1 })
 
 	// the queue full: c turned away at once, as OpenAI says a 429
-	began := time.Now()
 	g.send(context.Background(), "/v1/chat/completions", "slow/m", "c")
 	r := g.reply()
-	if r.tag != "c" || r.status != 429 || r.header.Get("Retry-After") == "" || time.Since(began) > 900*time.Millisecond {
+	if r.tag != "c" || r.status != 429 || r.header.Get("Retry-After") == "" {
 		t.Fatalf("c = %+v, want an immediate 429 with Retry-After", r)
 	}
+	// "immediate" by the lane's state, not the wall clock (#3061): c was
+	// answered before b left the queue — b still waits and the vendor was
+	// asked once, for a alone
+	if l := lane(); l.Waiting != 1 {
+		t.Fatalf("lane after c = %+v, want b still in the queue when c's 429 arrived", l)
+	}
+	if got := v.seen(); len(got) != 1 {
+		t.Fatalf("vendor saw %v, want a alone", got)
+	}
 	var oe struct {
 		Error struct{ Message, Type string } `json:"error"`
 	}
-- 
2.50.1 (Apple Git-155)
```

</details>
