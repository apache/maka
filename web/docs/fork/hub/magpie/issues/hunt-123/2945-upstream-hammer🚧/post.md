Taken — here is the analysis, the fix and its proof. Your trace and tobeforever's reproduction pinned the whole chain against current main (`dabb5722f`), and the fix is the planner-level hold your ask #1 describes, in the shape #1772's `quotaHeld` already has: when every key left rests an outage that its ladder has climbed twice, the request is answered from the rests, with a synthetic `Retry-After`, and the vendor is asked not at all.

## What's wrong

Three things combine into the 32-minute hammer, and your table shows each:

1. **A resting key still gets a real probe on every request.** `probeOne` (internal/gateway/fallback.go) keeps, of the candidates resting after a failure, only the one whose rest ends soonest — deliberately, "so a request still gets a real answer". When every key of the provider rests, that one candidate is the whole plan, and the walk asks it for real: your `order[]` shows both keys with `rest.until` in the future while `tries[]` records a fresh 502 dial on each request.
2. **The planner's hold covers outages of money, not outages of the wire.** `quotaHeld` (internal/gateway/gateway.go, your related #1772) answers from the rests only when every key left rests out of quota or credit. A `failOther` rest — your `"why": "other", "status": 502` — falls through to a real call, every time, from every conversation.
3. **One request makes several real calls on its own.** A 502 whose words say nothing (`failure()` classifies it `failOther`) reads as "busy" (internal/gateway/patience.go), so once the keys have failed, the request's own patience re-asks them in rounds — pauses of 2s, 4s, 8s … for its Patience budget (60s for a plain provider, at most 12 rounds) — and the same-one retries add two more asks of the last one left. That is why your minutes show more upstream attempts than top-level requests (27 attempts on 20 requests at 17:38).

The `MaxRPM` gate is the only thing that kept 115 top-level requests a minute from being 115 real calls: it absorbed 928 of them into local 429s and pinned the real ones at about 20/min per key — your 45 in the worst 61 seconds — for as long as the clients kept asking. And nothing ever let the ladder stop them: `failures` climbs only when a rest *ends* and a probe fails again, while probes landing inside the window re-note the rest from now. Your rest history is the ladder climbing one step per expired window, 1 → 2 → 3 → 5 → 8 … → 45.

## Root cause

The outage class already exists and is already served: `probeable` (internal/gateway/rest_probe.go, added Oct 29) defines it — a rest out of `failOther`, by `"backoff"`, at a status of 500 or more, or 408, or no status of its own — and asks the vendor's model list in the background during such a rest, lifting it as soon as the list answers. What was missing was answering *from* that state at the planner: nothing read it before sending a real call, so the background probe and the per-request probe ran side by side, yours against the vendor's dial timeout, 45 times a minute.

## The fix

- `outageRest` (internal/gateway/fallback.go) names that class once, and `probeable` reads it from there too.
- `outageHeld` holds when *every* candidate left rests such a rest with `Failures >= 2` — the ladder twice climbed, since a first failure may be a moment's, as a key is held once refused twice (#1772). The walk checks it where `quotaHeld` is checked, and at the same pre-check that truncates the candidate list when every key left rests, so the hold applies from the first candidate.
- Held, the agent is told `agentrouter (unreachable: not asked again before 18:18:43)` at the vendor's own status (502 for a connection that died), with the soonest rest back as a synthetic `Retry-After` — your ask #1's answer from the rest state — and no upstream call goes out.
- An answer held this way is not asked again within the request (`!held` on the same-one retries).
- Recovery stays with the background list probe, which lifts the rest as soon as the vendor answers; a first failure still rides out on the patience as before, since nothing holds until the ladder has climbed twice.

The steady state after the fix is one real call per key per rest window — the half-open probe your second bullet describes — over windows of 1, 2, 4 … 10 minutes. Your 706 calls in 32 minutes become about a dozen.

**Scope note, tobeforever's one-relay case:** a provider of one key sits out of this fix, because its failure is the last one left's, and the failure of the last one left rests nothing in magpie today — so no outage rest forms for the hold to answer from. A draft of this patch rested that failure too, and it broke sixteen pinned tests: Codex's compaction flow keeps asking on its own three-strikes budget, protection refusals, overflows and byte caps are the request's own trouble and must not rest, and the access probes must not either. That draft is dropped; the gap (a provider of one key never rests at all on a 5xx/EOF) is worth its own issue, and I have not mixed it into this one.

<details>
<summary>Patch (1e1039549)</summary>

```diff
From 1e1039549b647db39c5cbc25939737170deca876 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 5 Nov 2026 07:05:19 +0800
Subject: [PATCH] gateway: an outage twice failed is answered from the rests,
 not asked
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A relay that went dark kept being really asked for as long as its
clients kept asking. Every request probed a key resting after its
ladder — probeOne keeps the one back soonest for a real answer, and
the planner's hold answers from the rests out of quota or credit
alone (#1772), so a rest after the vendor could not be reached held
nothing: huluma1314's #2945 saw agentrouter.org, down for 32
minutes, really asked 706 times over 55 conversations, and 928 more
asks turned away by the keys' own MaxRPM, every one of them the
probe a resting key still got, each its patience's rounds.

Now a rest twice failed after the vendor could not be reached at all
— a 5xx, a 408, no answer of its own (the class the background list
is asked over, rest_probe.go, which is what lifts it again as soon
as the vendor answers) — holds the request where a quota rest holds
one: every key that was left resting so is answered from its rest,
with the soonest one back as Retry-After, and no upstream call is
made. A first failure may be a moment's, so only a ladder twice
climbed holds, as a key is held once refused twice. probeable reads
the outage class from outageRest beside outageHeld, and an answer
held this way is not asked again within the request.

The patience of a group, and the same-one retries before it, still
ride a first, momentary 5xx out as they did: nothing holds until
the ladder has climbed twice, and nothing rests that didn't before.

Test: internal/gateway/outage_hold_test.go, an upstream that takes
the connection and dies before a word (Go's client left reading
EOF, as a dark relay answers):
- TestAllRestingOutageAnswersFromRest: two keys fail, rest, and
  their ladder climbs over an ended rest; the requests after that
  are answered 502 with the provider named, when it is asked again,
  and a Retry-After of the soonest rest, and the vendor is asked
  not at all.

Run: the rest, plain5xx, proxy-down, backoff-ladder, rest-probe,
Codex-own-EOF and patience tests above them (23 green), the compaction,
protection, overflow and byte-cap tests my first draft's resting of
the last one left had broken (16 green again), gofmt -l, go vet
-tags nogui, and the whole gateway suite with -tags nogui.

Fixes #2945

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/fallback.go         |  38 +++++++
 internal/gateway/gateway.go          |  26 ++++-
 internal/gateway/outage_hold_test.go | 162 +++++++++++++++++++++++++++
 internal/gateway/rest_probe.go       |   8 +-
 4 files changed, 226 insertions(+), 8 deletions(-)
 create mode 100644 internal/gateway/outage_hold_test.go

diff --git a/internal/gateway/fallback.go b/internal/gateway/fallback.go
index 093f17a6b..7009145b7 100644
--- a/internal/gateway/fallback.go
+++ b/internal/gateway/fallback.go
@@ -1391,6 +1391,44 @@ func quotaStatus(status int) bool {
 	return status == http.StatusTooManyRequests || status == http.StatusPaymentRequired
 }
 
+// outageRest says r is a rest taken after the vendor could not be reached
+// at all — a 5xx, a 408, no answer of its own at all — for as long as its
+// ladder guesses ("backoff"), none of it a time the vendor named: the
+// class of rest the background list is asked over (rest_probe.go), and the
+// class a request is answered from once it is twice failed (outageHeld).
+func outageRest(r Rest) bool {
+	return r.Why == failOther && r.By == "backoff" &&
+		(r.Status >= 500 || r.Status == http.StatusRequestTimeout || r.Status == 0)
+}
+
+// outageHeld is, when every candidate of cs rests after its vendor could
+// not be reached — the connection dead, a dial that hung, a 5xx that says
+// nothing of why — the rest of the first, and when the soonest of them is
+// back: asked, each would fail the same (#2945: a relay down for 32
+// minutes was really asked 706 times over 55 conversations, every request
+// its resting keys' one probe). Only a ladder twice climbed holds, a
+// first failure being a moment's, as a key out of its allowance is held
+// once refused twice (quotaHeld, #1772); its rest is asked again in the
+// background meanwhile (rest_probe.go), which lifts it as soon as the
+// vendor answers again.
+func outageHeld(cs []candidate) (Rest, time.Time, bool) {
+	var first Rest
+	var back time.Time
+	for i, c := range cs {
+		r, ok := restingOf(c)
+		if !ok || !outageRest(r) || r.Failures < 2 {
+			return Rest{}, time.Time{}, false
+		}
+		if i == 0 {
+			first = r
+		}
+		if back.IsZero() || r.Until.Before(back) {
+			back = r.Until
+		}
+	}
+	return first, back, len(cs) > 0
+}
+
 // soonestBack is when the first of cs is back from its rest, or asked
 // again before it is (Rest.asksAt); false when one of them isn't resting.
 func soonestBack(cs []candidate) (time.Time, bool) {
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index ff28b0e26..04336c44f 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -3157,6 +3157,11 @@ func (s *Server) serve(w http.ResponseWriter, r *http.Request, from provider.Pro
 				// is back: none is asked, and the agent is told so at once
 				// (#1772)
 				cands = cands[:i+1]
+			} else if _, _, ok := outageHeld(cands[i:]); ok {
+				// every key left rests twice failed after its vendor could
+				// not be reached: none is asked, and the agent is told so
+				// at once (#2945)
+				cands = cands[:i+1]
 			}
 		}
 		if by := accountSkipped(r.Context(), c.p, c.model); by != "" {
@@ -3527,6 +3532,25 @@ func (s *Server) serve(w http.ResponseWriter, r *http.Request, from provider.Pro
 			// using this one rests that model of it alone (remoteModelRest)
 			noteMember(hw, r, c.p, c.model)
 			writeError(hw, from, call.Status, msg)
+		} else if rested, back, ok := outageHeld(cands[i:]); ok && last {
+			// it rests twice failed after its vendor could not be reached
+			// at all — the connection dead, a dial that hung, a 5xx that
+			// says nothing of why — and so does every key that was left
+			// (#2945: a relay down for 32 minutes was really asked 706
+			// times over 55 conversations, every request its resting keys'
+			// one probe): its failure is given again without asking, with
+			// when the soonest of them is back as Retry-After, for an
+			// agent that waits as told to ask then. Its list is asked in
+			// the background meanwhile (rest_probe.go), which lifts the
+			// rest as soon as the vendor answers again
+			msg := fmt.Sprintf("%s (unreachable: not asked again before %s)", c.p.Name, heldClock(back, time.Now()))
+			held, heldBack, call.Status, call.Error = true, back, cmp.Or(rested.Status, http.StatusBadGateway), msg
+			// the answer names who held it, as one asked would
+			noteMember(hw, r, c.p, c.model)
+			if wait := time.Until(back); wait > 0 {
+				w.Header().Set("Retry-After", strconv.Itoa(int((wait+time.Second-1)/time.Second)))
+			}
+			writeError(hw, from, call.Status, msg)
 		} else {
 			// a stream that fails before anything is said is let go at
 			// once (hw.stop), not read on until the vendor hangs up
@@ -4604,7 +4628,7 @@ func (s *Server) serve(w http.ResponseWriter, r *http.Request, from provider.Pro
 				break
 			}
 		}
-		if wait, ok := passing(hw.code(), hw.header, hw.errBody(), again); ok && !protected && !sameRefusal && !hw.turnedAway && hw.failed() && waitFrom.IsZero() && !kept.tooQuiet(wait) {
+		if wait, ok := passing(hw.code(), hw.header, hw.errBody(), again); ok && !held && !protected && !sameRefusal && !hw.turnedAway && hw.failed() && waitFrom.IsZero() && !kept.tooQuiet(wait) {
 			// nobody else is left: the same one again, after a moment (not
 			// what Antigravity turned away: it turns it away again; nor
 			// once the group's patience is spent)
diff --git a/internal/gateway/outage_hold_test.go b/internal/gateway/outage_hold_test.go
new file mode 100644
index 000000000..4ac39dfab
--- /dev/null
+++ b/internal/gateway/outage_hold_test.go
@@ -0,0 +1,162 @@
+package gateway
+
+import (
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"slices"
+	"strconv"
+	"strings"
+	"sync"
+	"testing"
+	"time"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// eofVendor is an upstream that takes the connection and dies before a
+// word: a relay whose site went dark answers this way, Go's client left
+// reading EOF for every attempt (#2945: agentrouter.org, down for 32
+// minutes, really asked 706 times over 55 conversations).
+type eofVendor struct {
+	mu    sync.Mutex
+	dials []string
+}
+
+func (e *eofVendor) ServeHTTP(w http.ResponseWriter, r *http.Request) {
+	io.Copy(io.Discard, r.Body)
+	e.mu.Lock()
+	e.dials = append(e.dials, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
+	e.mu.Unlock()
+	panic(http.ErrAbortHandler) // the connection dies with nothing said
+}
+
+func (e *eofVendor) took() []string {
+	e.mu.Lock()
+	defer e.mu.Unlock()
+	out := e.dials
+	e.dials = nil
+	return out
+}
+
+func eofChain(t *testing.T, keys ...string) (*eofVendor, *Server) {
+	t.Helper()
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	noRests()
+	t.Cleanup(noRests)
+	routed.Lock()
+	routed.failures = map[string]int{}
+	routed.Unlock()
+	t.Cleanup(func() {
+		routed.Lock()
+		routed.failures = map[string]int{}
+		routed.Unlock()
+	})
+	e := &eofVendor{}
+	up := httptest.NewServer(e)
+	t.Cleanup(up.Close)
+	p := provider.Provider{ID: "dark", Name: "dark", Chat: up.URL + "/v1", Models: []string{"glm-5.3-flash"}, Routing: provider.Ordered}
+	p.Key = keys[0]
+	for _, k := range keys[1:] {
+		p.Keys = append(p.Keys, provider.KeyAccount{Key: k})
+	}
+	if err := provider.Save(p); err != nil {
+		t.Fatal(err)
+	}
+	return e, New()
+}
+
+func postDark(t *testing.T, srv *Server) *httptest.ResponseRecorder {
+	t.Helper()
+	rec := httptest.NewRecorder()
+	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"dark/glm-5.3-flash","messages":[{"role":"user","content":"hi"}]}`))
+	req.Header.Set("Content-Type", "application/json")
+	srv.Handler().ServeHTTP(rec, req)
+	return rec
+}
+
+// expireRests ends every rest there is, as an outage long enough does a
+// minute, then two, after each: what a failure next makes is the ladder's
+// next step.
+func expireRests(t *testing.T) {
+	t.Helper()
+	restingUntil.Lock()
+	for k := range restingUntil.m {
+		restingUntil.m[k] = time.Now().Add(-time.Second)
+	}
+	restingUntil.Unlock()
+}
+
+// outageHeldOf says cs are all held: each rests its outage ladder's second
+// step at least.
+func outageHeldOf(t *testing.T, cs []candidate) {
+	t.Helper()
+	for _, c := range cs {
+		r, ok := restingOf(c)
+		if !ok || r.Why != failOther || r.By != "backoff" || r.Failures < 2 {
+			t.Fatalf("%s rests %+v (ok %v), want an outage rest twice climbed", c.rest, r, ok)
+		}
+	}
+}
+
+// #2945 (an upstream 502/EOF hammer): a relay went dark — every dial met
+// EOF — and magpie kept really asking it for 32 minutes, 706 calls over
+// 55 conversations, every request the probe its resting keys still got,
+// each try its patience's rounds. A key whose outage ladder has climbed
+// twice is now answered from the rests, not asked, with the soonest one
+// back as Retry-After; the list is asked in the background instead
+// (rest_probe.go), which lifts the rest as soon as the vendor answers.
+func TestAllRestingOutageAnswersFromRest(t *testing.T) {
+	rp, sp := retryPause, singlePatience
+	retryPause, singlePatience = time.Millisecond, 20*time.Millisecond
+	t.Cleanup(func() { retryPause, singlePatience = rp, sp })
+	e, srv := eofChain(t, "eof-a", "eof-b")
+
+	// the outage begins: each key fails once, and each rests as the one
+	// asked before the resting mate
+	for i := 0; i < 2; i++ {
+		if rec := postDark(t, srv); rec.Code != http.StatusBadGateway {
+			t.Fatalf("request %d: %d %s", i+1, rec.Code, rec.Body)
+		}
+		e.took()
+	}
+	// an outage long enough climbs the ladder: its first rest over, a
+	// failure again is counted again. The last one left's failure rests
+	// nothing, so each key climbs as the one asked before its resting mate
+	expireRests(t)
+	if rec := postDark(t, srv); rec.Code != http.StatusBadGateway {
+		t.Fatalf("the ladder's second step: %d %s", rec.Code, rec.Body)
+	}
+	e.took()
+	rec := postDark(t, srv)
+	if got := e.took(); len(got) == 0 || slices.Contains(got, "eof-a") {
+		t.Fatalf("the key resting twice failed was really asked (%v), want only the one not resting", got)
+	}
+	if rec.Code != http.StatusBadGateway {
+		t.Fatalf("the ladder's second step: %d %s", rec.Code, rec.Body)
+	}
+	outageHeldOf(t, []candidate{
+		{p: provider.Provider{ID: "dark"}, rest: "dark#" + provider.KeyID("eof-a")},
+		{p: provider.Provider{ID: "dark"}, rest: "dark#" + provider.KeyID("eof-b")},
+	})
+
+	// every key rests, twice failed: the next requests are answered from
+	// the rests, and the vendor is not asked at all
+	for i := 0; i < 3; i++ {
+		rec := postDark(t, srv)
+		if got := e.took(); len(got) != 0 {
+			t.Fatalf("request %d while every key rests twice failed: really asked %v", i+1, got)
+		}
+		if rec.Code != http.StatusBadGateway {
+			t.Fatalf("request %d: %d %s", i+1, rec.Code, rec.Body)
+		}
+		if !strings.Contains(rec.Body.String(), "dark (unreachable: not asked again before ") {
+			t.Errorf("request %d says neither who nor when: %s", i+1, rec.Body)
+		}
+		ra, err := strconv.Atoi(rec.Header().Get("Retry-After"))
+		if err != nil || ra < 60 || ra > 121 {
+			t.Errorf("request %d: Retry-After %q, want the time left of the soonest rest", i+1, rec.Header().Get("Retry-After"))
+		}
+	}
+}
diff --git a/internal/gateway/rest_probe.go b/internal/gateway/rest_probe.go
index 62f879038..612ac20db 100644
--- a/internal/gateway/rest_probe.go
+++ b/internal/gateway/rest_probe.go
@@ -72,13 +72,7 @@ var restProbes = struct {
 // A Retry-After the vendor sent with it is its word on when to ask again,
 // which a list asked sooner would go around.
 func probeable(c candidate, r Rest, header http.Header, now time.Time) bool {
-	if retryAfter(header, now) > 0 || c.p.Account != nil || r.Model != "" || r.Key != c.restKey() || r.Why != failOther || !c.p.ListAsks() {
-		return false
-	}
-	if r.By != "backoff" {
-		return false
-	}
-	if r.Status < 500 && r.Status != http.StatusRequestTimeout && r.Status != 0 {
+	if retryAfter(header, now) > 0 || c.p.Account != nil || r.Model != "" || r.Key != c.restKey() || !outageRest(r) || !c.p.ListAsks() {
 		return false
 	}
 	return probeBefore(now.Add(restProbeSteps[0]), r.Until)
-- 
2.50.1 (Apple Git-155)


```

Patch file SHA-256 (first 16): `64770c12ce36ddfd`

</details>

## Verification

| Check | Result |
| --- | --- |
| RED: the new test alone on the parent (`dabb5722f`) | fail — `really asked [eof-b eof-a eof-b eof-a eof-b eof-a eof-b eof-a]` while both keys rest twice-failed: the hammer at small scale |
| GREEN: after the fix | pass — 0 real dials; the answer is 502 with `dark (unreachable: not asked again before …)` and a `Retry-After` of the soonest rest's time left |
| Ablation: the hold branch dropped, test kept | red again on the same line (`really asked [eof-b eof-a eof-b]`); restored, green |
| The sixteen tests the first draft's last-one-left rest broke (compaction, protection, overflow, byte-cap, access probes, edge-blocked) | green again with that draft dropped; each pins a flow that deliberately keeps asking |
| `go test -tags nogui -timeout 25m -count=1 ./internal/gateway/` | ok, 659.7s, 0 failures |
| `go test -tags nogui -race` (the rest families) | ok |
| `gofmt -l`, `go vet -tags nogui`, `go build -tags nogui ./...` | clean (`internal/gui`'s cgo `-Wenum-conversion` warnings pre-exist on the parent) |
| `git am -3` on a clean tree at `upstream/main` | applies clean; the new test passes there |

## Not verified

- No agentrouter account or relay here: the fix is pinned against a fake upstream that takes the connection and kills it before a word — Go's client left reading EOF, your report's shape — not against the real site.
- The single-key gap above is analyzed but not fixed here.
- The steady-state reduction (your 45 calls/61s to one per rest window) needs one real occurrence behind a build with this in it to confirm.

Credit: your routing-trace tables are the evidence of the hammer's scale (706 real calls, 928 local 429s, the ladder at `failures: 45`), and tobeforever's second reproduction (82 top-level requests, 240 real calls, five Codex sessions, ~39–50 calls a minute) is what pinned the per-request multiplier and the shape of the breaker this follows.

AI use: written by GLM-5.3-Flash (ZCode); keep the author as ggbdpq <ggbdpq@gmail.com>.

**Branch with the commit**: [fix/2945-upstream-hammer](https://github.com/ggbdpq/magpie/tree/fix/2945-upstream-hammer) (head `1e1039549b647db39c5cbc25939737170deca876`).
