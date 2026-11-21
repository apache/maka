**What's wrong**

On pace routing, the first request after an idle period went out on the routing snapshot's stale share: in @ylongw's traces, 29% for account B while a 45% reading from half an hour earlier sat in the login cache. The stale share drew both accounts into one pace band, the recent-token tie-break picked B, and the turn's default affinity kept B first to the end of a 104-request tool turn — the fresh reading arrived with the next request but never got a say until the turn was over.

**Root cause**

`Allowances` answers a known agent at once (asking for fresh readings behind the request) and serves what the snapshot holds — and the snapshot kept its share even when a **newer reading was already in hand** in the login cache, put there by the Usage page or a background look. The band decision ran on the older of the two numbers for no reason but the snapshot's age.

**The fix** (1 file; the patch below)

A snapshot over a minute old now goes by the readings the login cache holds that are **newer than its own** — without asking anyone and without waiting for the read a fresh ask started: the same age-honesty the batch itself keeps (#1295), and the same go-by-what-was-read-last rule an agent not known yet goes by (`lastAllowances`). Later asks still never wait. A snapshot made stale (`StaleAllowance`) or let go (`renewedNow`) counts nothing in hand till its own read is back — the honesty cuts both ways.

**Verification**

| Check | Result |
| --- | --- |
| New `TestAllowancesGoByANewerReadingInHand` (snapshot seeded at 29% and two minutes old, a 45% reading in the cache, the read the ask started still out) | red on the parent `d8b3749ef`; ok with the change |
| `go vet -tags nogui`, `gofmt -l`, targeted run | clean / clean / ok (re-verified on resume) |

<details><summary>patch: provider: routing goes by a reading in hand newer than the stale snapshot it holds (#5029) — git am applies it as is; SHA-256 first 16: b9ba9124db46b951</summary>

```patch
From 8a4725ebc4e5f7582295d726ac065cc994f7d6fb Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 06:43:43 +0800
Subject: [PATCH] provider: routing goes by a reading in hand newer than the
 stale snapshot it holds (#5029)

Allowances answers a known agent at once, asking for fresh readings
behind the request, so the first request after an idle went out on what
the snapshot held: in ylongw's traces 29% for account B while a 45%
reading from half an hour before sat in the login cache. The stale share
drew both accounts into one pace band, the recent-token tie-break picked
B, and the turn's affinity kept B first to the end of a 104-request tool
turn.

A snapshot over a minute old now goes by the readings the login cache
holds that are newer than its own, asked for by the Usage page or a
background look, without asking anyone and without waiting for the read
the ask started: the same age-honesty the batch itself keeps (#1295),
and the same go-by-what-was-read-last rule an agent not known yet goes
by (lastAllowances). Later asks still never wait. A snapshot made stale
(StaleAllowance) or let go (renewedNow) counts nothing in hand till its
read is back.

TestAllowancesGoByANewerReadingInHand: red on d8b3749ef (snapshot seeded
at 29% and two minutes old, a 45% reading in the cache, the read the ask
started still out), green with the change.

Fixes #5029

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/routing.go      | 59 +++++++++++++++++++++++++
 internal/provider/routing_test.go | 71 +++++++++++++++++++++++++++++++
 2 files changed, 130 insertions(+)

diff --git a/internal/provider/routing.go b/internal/provider/routing.go
index 5057478b8..81e3937f9 100644
--- a/internal/provider/routing.go
+++ b/internal/provider/routing.go
@@ -783,14 +783,73 @@ func Allowances(agent string) map[string]Allowance {
 	}
 	c.Lock()
 	m, known := c.m[agent]
+	at := c.at[agent]
 	c.Unlock()
 	if !known {
 		// the first reading is still out: what each account said last
 		return lastAllowances(agent)
 	}
+	if at.IsZero() || time.Since(at) <= time.Minute {
+		// zero: made stale (StaleAllowance), or an account was let go
+		// (renewedNow) — read again at once, and what is in hand counts for
+		// nothing till that read is back
+		return m
+	}
+	// read over a minute ago: a reading in hand the login cache kept —
+	// the Usage page's, a background look's — can be newer than what the
+	// snapshot holds, and the request goes out on it now rather than wait
+	// for the read it just asked for: after an idle, the first request of
+	// a conversation went out on a stale share, drew the pace bands with
+	// it, and the turn's affinity kept the account that choice made to the
+	// end of a long tool turn (#5029)
+	if in := inHandAllowances(agent, m); len(in) > 0 {
+		merged := make(map[string]Allowance, len(m)+len(in))
+		for u, a := range m {
+			merged[u] = a
+		}
+		for u, a := range in {
+			merged[u] = a
+		}
+		return merged
+	}
 	return m
 }
 
+// inHandAllowances is what agent's accounts' readings in hand say, the
+// ones newer than what the snapshot m was read from: the login cache keeps
+// every reading with its time, and the snapshot's own reading times are
+// in c.read. No one is asked; a read out now isn't waited for.
+func inHandAllowances(agent string, m map[string]Allowance) map[string]Allowance {
+	logins, ok := usageLogins(agent)
+	if !ok {
+		return nil
+	}
+	c := &usedCache
+	c.Lock()
+	olds := make(map[string]time.Time, len(m))
+	for u := range m {
+		if st, ok := c.read[agent+"/"+strings.ToLower(u)]; ok {
+			olds[u] = st.at
+		}
+	}
+	c.Unlock()
+	now := time.Now()
+	out := map[string]Allowance{}
+	for _, l := range logins {
+		e, ok := loginReadingKnown(l)
+		if !ok || e.q.Error != "" || len(e.q.Windows) == 0 {
+			continue
+		}
+		if was, ok := olds[l.User]; ok && !e.at.After(was) {
+			continue // the snapshot's own reading of the account is as new
+		}
+		if a, ok := routedAllowance(agent, l.User, e.q, now); ok {
+			out[l.User] = a
+		}
+	}
+	return out
+}
+
 // UsageRead is when user's allowance under agent was last read well, and
 // whether the last try to read it failed (or was held back); ok is false
 // when it hasn't been tried since magpie started. A careful provider holds
diff --git a/internal/provider/routing_test.go b/internal/provider/routing_test.go
index 88a38ed6a..85c912ec5 100644
--- a/internal/provider/routing_test.go
+++ b/internal/provider/routing_test.go
@@ -212,6 +212,77 @@ func TestAllowancesStaleMidRead(t *testing.T) {
 	}
 }
 
+// A snapshot read over a minute ago goes by a reading in hand that is
+// newer than its own, at once, not only once the read it asked for comes
+// back: after an idle, the first request of a conversation went out on a
+// stale 29% while a 45% sat in the login cache, drew both accounts into
+// one pace band, and the turn's affinity kept the account that band chose
+// to the end of a 104-request tool turn (#5029).
+func TestAllowancesGoByANewerReadingInHand(t *testing.T) {
+	signIn(t)
+	t.Cleanup(ForgetAccounts) // the look a test's Logins made was this home's
+	ForgetAccounts()
+	week := time.Now().Add(72 * time.Hour)
+	release := make(chan struct{})
+	var once sync.Once
+	var readings atomic.Int32
+	LoginUsageVia(func(_ context.Context, agent string) map[string]SubscriptionQuota {
+		if readings.Add(1) == 1 {
+			<-release // the read the stale snapshot asked for stays out
+		}
+		return map[string]SubscriptionQuota{"me@example.com": {Windows: []QuotaWindow{{Span: 7 * 24 * time.Hour, Used: 45, ResetsAt: &week}}}}
+	})
+	reset := func() {
+		loginUsageCache.Lock()
+		delete(loginUsageCache.m, "codex/me@example.com")
+		loginUsageCache.Unlock()
+		usedCache.Lock()
+		usedCache.m, usedCache.at, usedCache.loading = map[string]map[string]Allowance{}, map[string]time.Time{}, map[string]chan struct{}{}
+		delete(usedCache.read, "codex/me@example.com")
+		usedCache.stale = nil
+		usedCache.Unlock()
+	}
+	reset()
+	t.Cleanup(func() {
+		once.Do(func() { close(release) })
+		// every reading this started lands before the stand-in goes
+		for {
+			usedCache.Lock()
+			done := usedCache.loading["codex"]
+			usedCache.Unlock()
+			if done == nil {
+				break
+			}
+			<-done
+		}
+		LoginUsageVia(nil)
+		reset()
+	})
+	// in hand: a reading made a minute and a half ago, at 45%; the
+	// snapshot's own: two minutes ago, at 29%
+	fresh := SubscriptionQuota{Windows: []QuotaWindow{{Span: 7 * 24 * time.Hour, Used: 45, ResetsAt: &week}}}
+	loginUsageCache.Lock()
+	if loginUsageCache.m == nil {
+		loginUsageCache.m = map[string]loginUsageEntry{}
+	}
+	loginUsageCache.m["codex/me@example.com"] = loginUsageEntry{at: time.Now().Add(-90 * time.Second), q: fresh, read: fresh}
+	loginUsageCache.Unlock()
+	usedCache.Lock()
+	usedCache.m["codex"] = map[string]Allowance{"me@example.com": {{Used: 29, Resets: week, Span: 7 * 24 * time.Hour}}}
+	usedCache.at["codex"] = time.Now().Add(-2 * time.Minute)
+	if usedCache.read == nil {
+		usedCache.read = map[string]readState{}
+	}
+	usedCache.read["codex/me@example.com"] = readState{at: time.Now().Add(-2 * time.Minute)}
+	usedCache.Unlock()
+	// known, so it answers at once — by what is in hand, not the stale
+	// snapshot; the read it asked for is still out
+	if u, _ := Allowances("codex")["me@example.com"].For("gpt-5.5", time.Now()); u != 45 {
+		t.Fatalf("went by the stale snapshot: %v%%", u)
+	}
+	once.Do(func() { close(release) })
+}
+
 // Copilot's allowances renew on the day GitHub says, and its code
 // completions don't stop an account from answering.
 func TestCopilotUsageResets(t *testing.T) {
-- 
2.50.1 (Apple Git-155)
```

</details>

**Branch with the commit**: [fix/5029-pace-stale-affinity](https://github.com/ggbdpq/magpie/tree/fix/5029-pace-stale-affinity) (head `8a4725ebc4e5f7582295d726ac065cc994f7d6fb`).

**Not verified:** no two-Grok-subscription remote installation here — the fix is proven at the unit seam (snapshot vs cache reading) with the report's shape as the fixture; the full 104-request tool turn is the reporter's trace, not a reproduction. The full-package gateway suite for this change was not re-run after the pause; the seam it touches is `Allowances`, and the provider package's checks above stand in.

**Attribution**: AI-written (GLM-5.3-Flash via ZCode); I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
