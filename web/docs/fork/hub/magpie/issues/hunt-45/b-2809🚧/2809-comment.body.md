Found by source review (the reporter was fixing #2762); I verified the shape on current main (`1a3b9268`) and it is as reported: `copilotAutoResolve` took `copilotAutoMu` with `defer` at entry and held it across `app.session(ctx)`, `copilotAutoRoute` (POST /auto, 15s timeout) and the `/models/session` fallback — and across the cache read for every other account, so even a warm cache lookup waited on one account's slow upstream. Two things I confirmed beyond the report: production only ever passes `fresh=false` today (`copilotAutoSign` and the account's `auto` func; `fresh=true` is test-only), and the refusal invalidation is enforced twice — by the `!copilotRefuses(...)` clause in the cache check and by the delete in `copilotRefused` — either alone keeping the refusal behavior, so both stay.

Branch: [`hunt45-b-copilot-auto-mu`](https://github.com/ggbdpq/magpie/tree/hunt45-b-copilot-auto-mu), one commit on top of upstream `1a3b9268860263f263a2c832b1f9b6d1b57e3fa0`; the patch below applies with `git am`.

## What changed

`internal/provider/copilot_auto.go`:

- `copilotAutoInflight` (`copilot_auto.go:165`), keyed by `copilotAutoAsking{token, fresh}`, holds the resolution being asked for an account (`copilotAutoWait`: a done channel plus the session or error, `:171-186`).
- `copilotAutoResolve` (`:201`) now takes `copilotAutoMu` three times, briefly: the cache read (`:204-208`, the same condition as before), the flight registration (`:210-217`), and the answer's keeping (`:225-232`: store to the sessions map when the ask succeeded, drop the flight, close the channel). A caller that finds a flight in progress waits on its `done` — or on its own `ctx.Done()`, so it can leave early — and takes that ask's session or error (`:219-224`).
- The asking moved to `copilotAutoAsk` (`:238`), the old body with no lock held and no stores: the session trade, POST /auto and the /models/session fallback are the same code as before, and the three `copilotAutoSessions[...] = a` stores of the old resolve (route success, fallback, /models/session) became the one store in `copilotAutoResolve`.
- `ForgetCopilotForTest` (`:518`) also clears the flight map.

`fresh` semantics unchanged: a fresh ask skips the cache and, being a distinct flight key, waits for its own ask rather than another caller's. Refusal invalidation unchanged: the cache check still refuses to hand out a session whose model the account was refused, and the ask itself still passes refused models over.

Test (`internal/provider/copilot_auto_test.go:209-346`): `autoHeld` is an Auto upstream whose /models/session answer waits on a gate (counting the asks), reached as the real path reaches it — POST /auto first (404 here, as for accounts without Auto v2), then the session ask. `TestCopilotAutoConcurrent` holds account A's answer while account B's cold resolution must come within 2s, and asks the same account twice together (fresh, so no cache answers the second) and wants one upstream ask with both callers holding the same session.

## Red before the fix

Base `1a3b9268860263f263a2c832b1f9b6d1b57e3fa0`, `go test -tags nogui -count=1 -run 'TestCopilotAutoConcurrent' ./internal/provider/`:

```
--- FAIL: TestCopilotAutoConcurrent (2.12s)
    copilot_auto_test.go:303: an account's Auto resolution held another account's: B's wasn't answered within 2s while A's upstream answer was held
    copilot_auto_test.go:343: the same account asked twice together went upstream 2 times, want once
FAIL
```

Ablation (original file restored, test kept): the same two failures. After the change, both pass.

## Verification

| Check | Result |
| --- | --- |
| `go test -tags nogui -count=1 -run 'TestCopilotAuto' ./internal/provider/` | ok, 8/8 (1.6s) |
| `go test -tags nogui -count=1 ./internal/provider/` | ok, 1226 tests, 0 failures (68.7s) |
| `go test -race -tags nogui -count=1 -run 'TestCopilotAuto' ./internal/provider/` ×3 | pass, each run (2.06s / 2.03s / 2.01s) |
| `gofmt -l internal/provider/` | empty |
| `go vet -tags nogui ./internal/provider/` (darwin / GOOS=linux / GOOS=windows) | clean |
| `go build -tags nogui ./...`; `GOOS=linux go build -tags nogui ./...`; `GOOS=windows go build -tags nogui -o /dev/null .` | clean (one pre-existing C enum-conversion warning in internal/gui/trayimage_darwin.go, untouched) |

Mutations, each redden its own assertion (all restored after):

- the lock held across the ask again: B's resolution unanswered within 2s (and the second same-account caller never reaches the flight: 2 upstream asks)
- the per-account dedupe dropped: 2 upstream asks, want once
- the refusal invalidation dropped (the cache-check clause and `copilotRefused`'s delete — dropping either alone leaves the tests green, they cover each other): `TestCopilotAutoRefusedPicksAnother` and `TestCopilotAutoFallbackServed` fail

## Siblings

Locks held across network calls in the same package, left as they are:

- `copilotToken` (internal/provider/account.go) holds `copilotMu` across the token-exchange GET, and `copilotDirect` (internal/provider/copilot_cli.go) holds it across the CLI's endpoint GET — this is the session-token lock the report scopes to #2762, so I kept my hands off it here.
- `copilotTermsMu` (in `copilotAutoFallback` and `copilotAccept`) and `copilotSeenMu` are released before any network call — nothing to change.
- After this patch `copilotAutoMu` itself is held for the sessions map and the flight bookkeeping only.

## Not verified

No real GitHub account or real Copilot Auto upstream was used. The fakes follow the request path as this repo makes it: POST /auto with `{"prompt":…,"tier":"balance"}` at `X-GitHub-Api-Version: 2026-08-01` (answered 404 here, as for accounts without Auto v2), then POST /models/session with `{"auto_mode":{"model_hints":["auto"]}}` at `2025-10-01`, with the session seeded the way `copilotToken` keeps it. The same-account assertion counts upstream asks after both callers have returned, so the count is deterministic; the 100ms pause before opening the gate only gives the second caller time to land on the first's ask.

**AI**: written with an AI coding agent; I've read the whole diff and can answer questions on it myself. The model name is in the commit's trailer.

**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.

<details><summary>patch (0001-provider-a-Copilot-Auto-resolution-for-one-account-d.patch, sha256 00f0d13ddfedb000…)</summary>

```patch
From eeb96ee5eb4e0d2d0c99bc3fcd22930928da5fdb Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 19 Oct 2026 06:53:00 +0800
Subject: [PATCH] provider: a Copilot Auto resolution for one account doesn't
 hold the others' behind one lock (#2809)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed:

copilotAutoResolve kept copilotAutoMu from entry to return: the cache
lookup, app.session, POST /auto (copilotAutoRoute) and the /models/session
fallback all ran under it, so an account whose Copilot answered slowly held
every account's Auto lookups and resolutions behind one lock. Now the lock
is held for the cache read, the per-account flight bookkeeping and the
answer's keeping alone, and the asking moved to copilotAutoAsk with no lock
held; a resolution being asked for an account (copilotAutoInflight, keyed
by token and fresh) is joined by the callers that land on it, which share
its session or its error — a fresh ask still waits for its own ask, and a
model the account was refused still forces the ask anew.

Why:

The lock has to serialize the sessions map, never the network. #2809 was
found by source review; this makes the map-and-network split and its
evidence concrete on main (1a3b9268).

Run (darwin/arm64, go 1.26.8):

- TestCopilotAutoConcurrent on base: B's cold resolution unanswered within
  2s while A's upstream answer was held; the same account asked twice went
  upstream 2 times. After the change: B answered, one upstream ask.
- TestCopilotAuto* 8/8 pass; the package's 1226 tests pass in 68.7s.
- -race on TestCopilotAuto* three runs: pass each.
- go vet (darwin/linux/windows), gofmt, and builds for the three: clean.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/copilot_auto.go      |  68 ++++++++++--
 internal/provider/copilot_auto_test.go | 141 +++++++++++++++++++++++++
 2 files changed, 202 insertions(+), 7 deletions(-)

diff --git a/internal/provider/copilot_auto.go b/internal/provider/copilot_auto.go
index c40cd84f..94163dba 100644
--- a/internal/provider/copilot_auto.go
+++ b/internal/provider/copilot_auto.go
@@ -158,8 +158,29 @@ func pickRefused(ctx context.Context, model, said string) {
 var (
 	copilotAutoMu       sync.Mutex
 	copilotAutoSessions = map[string]copilotAutoSession{} // by GitHub token
+	// copilotAutoInflight is the Auto session being asked for an account,
+	// by GitHub token and whether the ask was fresh: callers landing on it
+	// while it is being asked wait for its answer instead of asking Copilot
+	// again (#2809).
+	copilotAutoInflight = map[copilotAutoAsking]*copilotAutoWait{}
 )
 
+// copilotAutoAsking says whose Auto session is being asked: the account,
+// and whether the ask was a fresh one (a fresh ask is answered by its own
+// ask, not by another caller's).
+type copilotAutoAsking struct {
+	token string
+	fresh bool
+}
+
+// copilotAutoWait is one account's Auto ask the others are waiting on: its
+// session, or why it has none, said once done is closed.
+type copilotAutoWait struct {
+	done chan struct{}
+	a    copilotAutoSession
+	err  error
+}
+
 type copilotAutoKey struct{}
 
 type copilotAutoPromptKey struct{}
@@ -172,13 +193,49 @@ func WithAutoPrompt(ctx context.Context, prompt string) context.Context {
 
 // copilotAutoResolve is the account's Auto session, asked again a couple of
 // minutes before it expires, when fresh is set or once the account was
-// refused its model.
+// refused its model. The ask is one per account at a time and its callers
+// share its session or its error; no account's ask holds another's, one
+// account's slow answer having held every account's lookups behind
+// copilotAutoMu (#2809). The lock is held for the cache and the answer's
+// keeping alone, never for the asking.
 func copilotAutoResolve(ctx context.Context, app copilotApp, fresh bool) (copilotAutoSession, error) {
 	copilotAutoMu.Lock()
-	defer copilotAutoMu.Unlock()
 	if a, ok := copilotAutoSessions[app.Token]; ok && !fresh && (a.ExpiresAt == 0 || time.Until(time.Unix(a.ExpiresAt, 0)) > 2*time.Minute) && !copilotRefuses(app.Token, a.Model) {
+		copilotAutoMu.Unlock()
 		return a, nil
 	}
+	key := copilotAutoAsking{app.Token, fresh}
+	call, waiting := copilotAutoInflight[key]
+	if !waiting {
+		call = &copilotAutoWait{done: make(chan struct{})}
+		copilotAutoInflight[key] = call
+	}
+	copilotAutoMu.Unlock()
+	if waiting {
+		select {
+		case <-call.done:
+			return call.a, call.err
+		case <-ctx.Done():
+			return copilotAutoSession{}, ctx.Err()
+		}
+	}
+	a, err := copilotAutoAsk(ctx, app)
+	copilotAutoMu.Lock()
+	if err == nil {
+		copilotAutoSessions[app.Token] = a
+	}
+	call.a, call.err = a, err
+	delete(copilotAutoInflight, key)
+	close(call.done)
+	copilotAutoMu.Unlock()
+	return a, err
+}
+
+// copilotAutoAsk asks Copilot the account's Auto session with no lock held:
+// the session (its endpoint may want asking), POST /auto as Copilot Chat
+// does, and /models/session when /auto doesn't answer. copilotAutoResolve
+// keeps what it answers for the callers waiting on it.
+func copilotAutoAsk(ctx context.Context, app copilotApp) (copilotAutoSession, error) {
 	s, err := app.session(ctx)
 	if err != nil {
 		return copilotAutoSession{}, err
@@ -186,7 +243,6 @@ func copilotAutoResolve(ctx context.Context, app copilotApp, fresh bool) (copilo
 	base := s.apiBase(app.Host)
 	a, why, answered := copilotAutoRoute(ctx, app, s, base)
 	if why == "" {
-		copilotAutoSessions[app.Token] = a
 		return a, nil
 	}
 	if answered {
@@ -260,9 +316,7 @@ func copilotAutoResolve(ctx context.Context, app copilotApp, fresh bool) (copilo
 	if model == "" {
 		return copilotAutoSession{}, errors.New("Copilot Auto picked no model")
 	}
-	a = copilotAutoSession{Token: v.Token, Model: model, ExpiresAt: v.ExpiresAt, Via: "/models/session", Skipped: why}
-	copilotAutoSessions[app.Token] = a
-	return a, nil
+	return copilotAutoSession{Token: v.Token, Model: model, ExpiresAt: v.ExpiresAt, Via: "/models/session", Skipped: why}, nil
 }
 
 // copilotAutoRoute asks POST /auto for the model, as Copilot Chat does, at
@@ -341,7 +395,6 @@ func copilotAutoFallback(ctx context.Context, app copilotApp, why string) (copil
 		return copilotAutoSession{}, errors.New("Copilot doesn't offer Auto to this account (" + why + "), and lists no model it may pick by hand that it serves; check the plan at github.com/settings/copilot")
 	}
 	a := copilotAutoSession{Model: picks[0], ExpiresAt: time.Now().Add(10 * time.Minute).Unix(), Via: AutoFallback, Skipped: why}
-	copilotAutoSessions[app.Token] = a
 	return a, nil
 }
 
@@ -462,6 +515,7 @@ func ForgetCopilotForTest() {
 	copilotMu.Unlock()
 	copilotAutoMu.Lock()
 	copilotAutoSessions = map[string]copilotAutoSession{}
+	copilotAutoInflight = map[copilotAutoAsking]*copilotAutoWait{}
 	copilotAutoMu.Unlock()
 	copilotTermsMu.Lock()
 	copilotTerms, copilotPicks = map[string]map[string]bool{}, map[string][]string{}
diff --git a/internal/provider/copilot_auto_test.go b/internal/provider/copilot_auto_test.go
index eba98470..23722be1 100644
--- a/internal/provider/copilot_auto_test.go
+++ b/internal/provider/copilot_auto_test.go
@@ -203,6 +203,147 @@ func TestCopilotAutoSessionAsVSCode(t *testing.T) {
 	}
 }
 
+// autoHeld is an Auto upstream whose /models/session answer is held until
+// its gate is opened, counting the asks it was and saying so on arrived.
+type autoHeld struct {
+	mu      sync.Mutex
+	asks    int
+	gate    chan struct{}
+	open    sync.Once
+	arrived chan struct{}
+	srv     *httptest.Server
+}
+
+func newAutoHeld(t *testing.T) *autoHeld {
+	t.Helper()
+	h := &autoHeld{gate: make(chan struct{}), arrived: make(chan struct{}, 4)}
+	h.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		if r.URL.Path == "/auto" {
+			w.WriteHeader(404) // Auto v2 not offered: /models/session
+			return
+		}
+		if r.URL.Path != "/models/session" || r.Method != http.MethodPost {
+			w.WriteHeader(404)
+			return
+		}
+		h.mu.Lock()
+		h.asks++
+		h.mu.Unlock()
+		select {
+		case h.arrived <- struct{}{}:
+		default:
+		}
+		<-h.gate
+		io.WriteString(w, `{"session_token":"held-tok","selected_model":"m-held","available_models":["m-held"],"expires_at":0}`)
+	}))
+	t.Cleanup(func() {
+		h.open.Do(func() { close(h.gate) }) // let a held answer go before the server is closed
+		h.srv.Close()
+	})
+	return h
+}
+
+func (h *autoHeld) count() int {
+	h.mu.Lock()
+	defer h.mu.Unlock()
+	return h.asks
+}
+
+func (h *autoHeld) openNow() { h.open.Do(func() { close(h.gate) }) }
+
+// An account's Auto resolution asked while another account's answer is held
+// is answered all the same (#2809: one lock over every account's Auto asked
+// them one by one), and the same account asked twice together goes upstream
+// once, the second sharing the first's session.
+func TestCopilotAutoConcurrent(t *testing.T) {
+	signIn(t)
+	copilotAutoSessions = map[string]copilotAutoSession{}
+	sess := func(api string) copilotSession {
+		s := copilotSession{Token: "sess", ExpiresAt: time.Now().Add(time.Hour).Unix()}
+		s.Endpoints.API = api
+		return s
+	}
+	held := newAutoHeld(t)
+	free := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		if r.URL.Path == "/auto" {
+			w.WriteHeader(404)
+			return
+		}
+		if r.URL.Path != "/models/session" || r.Method != http.MethodPost {
+			w.WriteHeader(404)
+			return
+		}
+		io.WriteString(w, `{"session_token":"free-tok","selected_model":"m-free","available_models":["m-free"],"expires_at":0}`)
+	}))
+	defer free.Close()
+	copilotSessions = map[string]copilotSession{
+		"gho_held": sess(held.srv.URL),
+		"gho_free": sess(free.URL),
+	}
+	appA := copilotApp{User: "octocat", Token: "gho_held"}
+	appB := copilotApp{User: "hubot", Token: "gho_free"}
+
+	// A's answer is held upstream; B's cold resolution is asked meanwhile
+	// and answered, its session come within 2s
+	doneA := make(chan error, 1)
+	go func() { _, err := copilotAutoResolve(context.Background(), appA, false); doneA <- err }()
+	<-held.arrived
+	modelB := make(chan string, 1)
+	failedB := make(chan error, 1)
+	go func() {
+		a, err := copilotAutoResolve(context.Background(), appB, false)
+		if err != nil {
+			failedB <- err
+			return
+		}
+		modelB <- a.Model
+	}()
+	select {
+	case <-time.After(2 * time.Second):
+		t.Error("an account's Auto resolution held another account's: B's wasn't answered within 2s while A's upstream answer was held")
+	case err := <-failedB:
+		t.Errorf("B's Auto resolution failed instead of a session: %v", err)
+	case m := <-modelB:
+		if m != "m-free" {
+			t.Errorf("B's Auto picked %q, want m-free", m)
+		}
+	}
+	held.openNow()
+	if err := <-doneA; err != nil {
+		t.Errorf("A's Auto resolution: %v", err)
+	}
+
+	// the same account asked twice together (fresh, so no cache answers
+	// the second): one ask upstream, its session shared, not one ask each
+	held2 := newAutoHeld(t)
+	copilotSessions["gho_twice"] = sess(held2.srv.URL)
+	appC := copilotApp{User: "octocat", Token: "gho_twice"}
+	picked := make(chan copilotAutoSession, 2)
+	askErr := make(chan error, 2)
+	for i := 0; i < 2; i++ {
+		go func() {
+			a, err := copilotAutoResolve(context.Background(), appC, true)
+			picked <- a
+			askErr <- err
+		}()
+	}
+	<-held2.arrived
+	time.Sleep(100 * time.Millisecond) // the second caller lands on the first's ask
+	held2.openNow()
+	for i := 0; i < 2; i++ {
+		if err := <-askErr; err != nil {
+			t.Fatalf("the same account asked twice together: %v", err)
+		}
+	}
+	a1, a2 := <-picked, <-picked
+	if a1 != a2 || a1.Model != "m-held" {
+		t.Errorf("asked together picked %+v and %+v, want one session for m-held", a1, a2)
+	}
+	if n := held2.count(); n != 1 {
+		t.Errorf("the same account asked twice together went upstream %d times, want once", n)
+	}
+}
+
 // An account Copilot has no Auto session for (404 however asked) is told
 // so, and goes on with the first model it may pick by hand, when it has one.
 func TestCopilotAutoUnavailable(t *testing.T) {
-- 
2.50.1 (Apple Git-155)

```

</details>
