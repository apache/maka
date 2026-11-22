Carrying @Yukaii's fix series (`4ca28f807` + `14dbd36db` on their branch `fix/claude-ratelimit-reset-headers`) — author kept on both commits — and verified at the current main. The fix is theirs as written (cherry-picked, no conflicts); added on my side: this verification.

**What the series does** (the report's two root causes, one commit each):

1. **`gateway: Claude subscription 429s carry Anthropic unified rate-limit reset headers`** — the Claude subscription bridge records the rejected `rate_limit_event` info on `KError` events, emits `anthropic-ratelimit-unified-status/-reset/-representative-claim` on Anthropic `429` responses (falling back to stored full windows or `provider.ClaudeResetTime` parsing of the refusal text), keeps all the unified headers through `keepRetry`, and saves them on `Rest.outHeader` in `restAfterMarked` so `timedHeld`/`quotaHeld` replay them on later `429`s — clamping `anthropic-ratelimit-unified-reset` to `soonestBack` across a multi-account pool.
2. **`agent: T3 Code can keep Claude Code's claude.ai sign-in`** — T3 Code's magpie provider instance gets the same `sign-in` (`login=claudeai`) field the `claude` agent already has: `ANTHROPIC_AUTH_TOKEN` goes empty so Claude Code keeps parsing the unified headers (a non-empty token suppresses that parsing), with sync, reconnect and Check preserving it.

Together: T3 Code's usage-limit banner shows the reset time and auto-resumes when the limit resets, instead of "retry manually".

| Element | Evidence (darwin/arm64; suites ran on upstream/main `0a735cae0` + the two commits) |
| --- | --- |
| GREEN | the four new gateway tests green (`TestClaudeSubscription429SaysUnifiedRejectionHeaders`, `TestClaude429UnifiedHeadersThroughGatewayAndKeepRetry`, `TestClaudeAllowanceHeadersThroughTheGateway`, `TestClaudeSubscriptionReplySaysTheAllowance`); `TestT3CodeKeepsItsClaudeAISignIn` and the T3 Code family green in `internal/agent`; `TestStateListsT3Code` green in `internal/gui` |
| RED (gateway half out) | reverting the gateway product files, tests kept: `claude_ratelimit_headers_test.go:208: anthropic-ratelimit-unified-reset: "", want "1795259017"` (+ `-5h-reset`/`-7d-reset`/`-5h-utilization` all empty) — the report's missing-headers face verbatim |
| RED (agent half out) | reverting the agent product file, tests kept: `t3code_test.go:454: T3 Code has no sign-in field` — matches the reporter's own red line |
| Touched packages, full | `internal/gateway` `go test -tags nogui -timeout 45m -count=1` → 946s, 75 reds; base `0a735cae0` same recipe → 75 reds; comm of the red sets: two tip-only names, both the load-order flake family — `TestClaudeUnloadableSessionStartsAnew` and `TestSearchQueueKeepsCodexAlive` re-run 3/3 green on the branch. `internal/agent` full → one red `TestMothX`, `internal/provider` full → one red `TestResolveVia` — both the known local proxy reds, base same |
| `-race` | the four gateway tests and the T3 Code family green under `-race` |
| gofmt / `git diff --check` | clean |
| vet ×3 / build ×3 | darwin / linux / windows (`nogui`) — gateway, agent, gui, provider clean |
| git am | the patch below applies cleanly on current main (`d84f764ac`); the replayed tree `bc10661ddac8ac152855a5c391b458f80c90e41d` equals the branch head's tree; author kept on both commits |

NOT-RUNNABLE here: a real Claude subscription 429 and a real T3 Code ingestor (paid account) — the reporter verified the header contract against `claude 2.1.329` and T3 Code's `claudeAgent` ingestor directly; the tests drive the same gateway paths a live run takes.

Sibling notes: the unified-header family (`keepRetry`/`restAfterMarked`/`timedHeld`/`quotaHeld`) is exactly the set this patch touches; the `login=claudeai` field mirrors the `claude` agent's existing option, and the t3code mirror is the new surface. #7403's review request covers the advisor-effort fixes (#6851) — a different face, untouched here.

**Branch with the commits**: [`fix/7405-claude-429-reset-headers`](https://github.com/ggbdpq/magpie/tree/fix/7405-claude-429-reset-headers) (head `0ecb8f4af80f2743c7866a292597758ccfabfea8`). Patch, `git am` ready, sha256[:16] `9b9fe4628cc026a7`:

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: Yukai Huang <yukaihuangtw@gmail.com>
Date: Sat, 21 Nov 2026 13:44:37 +0800
Subject: [PATCH 1/2] gateway: Claude subscription 429s carry Anthropic unified
 rate-limit reset headers

When a Claude subscription turn fails with 429 because its allowance is
exhausted, downstream Claude Code (including T3 Code's claudeAgent) only
emits rate_limit_event / api_error_params.rate_limit_info with resetsAt
when the 429 carries anthropic-ratelimit-unified-status: rejected,
anthropic-ratelimit-unified-reset, and
anthropic-ratelimit-unified-representative-claim. Without those headers,
T3 Code reports that the provider did not report a reset time and cannot
auto-resume when the limit resets.

- Record rejected rate_limit_event info on KError events in the Claude
  subscription bridge and emit the unified rejection headers on 429
  Anthropic responses (falling back to kept full windows or parsing the
  refusal text via provider.ClaudeResetTime when no rate_limit_event
  arrived).
- Preserve all anthropic-ratelimit-unified-* headers in keepRetry so
  upstream / remote-magpie 429s keep status and representative-claim.
- Save rejected unified headers on Rest.outHeader in restAfterMarked so
  timedHeld / quotaHeld replay them on subsequent 429s, and clamp
  anthropic-ratelimit-unified-reset to the soonest account back across a
  multi-account pool.

Verified:
- Red before fix: TestClaudeSubscription429SaysUnifiedRejectionHeaders and
  TestClaude429UnifiedHeadersThroughGatewayAndKeepRetry failed on missing
  anthropic-ratelimit-unified-{status,reset,representative-claim,overage-status}.
- Green after fix with -race: go test -tags nogui -race ./internal/gateway
  -run 'TestClaudeSubscriptionReplySaysTheAllowance|TestClaudeAllowanceHeadersThroughTheGateway|TestClaudeSubscription429SaysUnifiedRejectionHeaders|TestClaude429UnifiedHeadersThroughGatewayAndKeepRetry|TestClaudeModelRateRestsThatModelOnly'
---
 docs/subsystems/claude-subscription-bridge.md |  17 +-
 .../gateway/claude_ratelimit_headers_test.go  | 253 ++++++++++++++++++
 internal/gateway/claude_subscription.go       | 237 +++++++++++++++-
 internal/gateway/gateway.go                   |  27 +-
 internal/gateway/ir.go                        |  18 +-
 internal/gateway/routing.go                   |   9 +-
 internal/provider/claude_usage_cli.go         |   7 +
 7 files changed, 551 insertions(+), 17 deletions(-)

diff --git a/docs/subsystems/claude-subscription-bridge.md b/docs/subsystems/claude-subscription-bridge.md
index 1bce700b3..bc6d90024 100644
--- a/docs/subsystems/claude-subscription-bridge.md
+++ b/docs/subsystems/claude-subscription-bridge.md
@@ -2237,7 +2237,22 @@ Anthropic sends (`limitHeaders`, from `provider.KeptClaudeLimits`): a share
 from 0 to 1 and a Unix-seconds reset, for each kept window that says when
 it renews. They are set when the request comes in, from what is kept, and
 again as the reply begins (`relay`'s `begin`), once the turn's own
-`rate_limit_event` is in. A run on Claude Code's own home that has moved to
+`rate_limit_event` is in. When a Claude subscription turn fails with 429
+because its allowance is spent, `relayFailing` refreshes `limitHeaders` and
+calls `rejectedLimitHeaders` to also emit Anthropic's unified rejection
+headers (`anthropic-ratelimit-unified-status: rejected`,
+`anthropic-ratelimit-unified-reset`,
+`anthropic-ratelimit-unified-representative-claim`, and
+`anthropic-ratelimit-unified-overage-status` when reported) for Anthropic
+clients — taken from the turn's rejected `rate_limit_event`
+(`claudeRejectedLimit`), else from the account's kept full window
+(`provider.KeptClaudeLimits`) or the refusal's reset time
+(`provider.ClaudeResetTime`). `restAfterMarked` keeps those headers on the
+candidate's `Rest.outHeader` so `timedHeld`/`quotaHeld` replays them on
+subsequent held 429s, `keepRetry` preserves upstream
+`anthropic-ratelimit-unified-*` headers on 429s, and a multi-account pool
+clamps `anthropic-ratelimit-unified-reset` to the soonest account back.
+A run on Claude Code's own home that has moved to
 another account says nothing (`ClaudeCodeMovedOff`), as its event isn't
 kept either.
 An event names only some windows (often `five_hour` alone): the rest
diff --git a/internal/gateway/claude_ratelimit_headers_test.go b/internal/gateway/claude_ratelimit_headers_test.go
index 7aeefeeee..29eb91ed6 100644
--- a/internal/gateway/claude_ratelimit_headers_test.go
+++ b/internal/gateway/claude_ratelimit_headers_test.go
@@ -149,3 +149,256 @@ done
 		}
 	}
 }
+
+// A Claude subscription 429 for an exhausted allowance carries Anthropic's
+// unified rejection headers (status, reset, representative-claim) so a
+// downstream Claude Code signed in to claude.ai (including T3 Code) emits
+// rate_limit_event with resetsAt and can auto-resume when the limit resets.
+func TestClaudeSubscription429SaysUnifiedRejectionHeaders(t *testing.T) {
+	five := time.Now().Add(2 * time.Hour).Unix()
+	week := time.Now().Add(4 * 24 * time.Hour).Unix()
+	user := "rej-" + strconv.FormatInt(time.Now().UnixNano(), 36) + "@example.com"
+	owner := "claude\x00" + user
+	rejectedEvent := `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","resetsAt":` + strconv.FormatInt(five, 10) +
+		`,"overageStatus":"rejected","unifiedWindows":{"five_hour":{"utilization":1,"resetsAt":` + strconv.FormatInt(five, 10) + `},"seven_day":{"utilization":0.25,"resetsAt":` + strconv.FormatInt(week, 10) + `}}}}`
+	refusal := `{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"You've hit your 5-hour limit · resets 1:20pm (Asia/Taipei)"}`
+
+	ask := func(proto provider.Protocol, owner string, stream bool, lines []string) *httptest.ResponseRecorder {
+		t.Helper()
+		s := New()
+		start := func(_ context.Context, req *Request) (*subscriptionRun, <-chan Event, error) {
+			run := &subscriptionRun{bridge: s.subscription, token: "rej", pending: map[string]chan mcpToolResult{}}
+			run.owner.Store(&owner)
+			events := run.attach()
+			go run.readOutput(strings.NewReader(strings.Join(lines, "\n") + "\n"))
+			return run, events, nil
+		}
+		var body, url string
+		if proto == provider.Anthropic {
+			url = "/v1/messages"
+			body = `{"model":"claude-sonnet-5","max_tokens":100,"stream":` + strconv.FormatBool(stream) + `,"messages":[{"role":"user","content":"hi"}]}`
+		} else {
+			url = "/v1/chat/completions"
+			body = `{"model":"claude-sonnet-5","stream":` + strconv.FormatBool(stream) + `,"messages":[{"role":"user","content":"hi"}]}`
+		}
+		rec := httptest.NewRecorder()
+		var u Usage
+		if code, msg := s.serveSubscription(rec, httptest.NewRequest("POST", url, strings.NewReader(body)), proto, "Claude Code", "claude-sonnet-5", owner, []byte(body), &u, start); code != http.StatusTooManyRequests {
+			t.Fatalf("code %d (%s), want 429", code, msg)
+		}
+		return rec
+	}
+
+	want := map[string]string{
+		"anthropic-ratelimit-unified-status":               "rejected",
+		"anthropic-ratelimit-unified-reset":                strconv.FormatInt(five, 10),
+		"anthropic-ratelimit-unified-representative-claim": "five_hour",
+		"anthropic-ratelimit-unified-overage-status":       "rejected",
+		"anthropic-ratelimit-unified-5h-status":            "rejected",
+		"anthropic-ratelimit-unified-5h-utilization":       "1",
+		"anthropic-ratelimit-unified-5h-reset":             strconv.FormatInt(five, 10),
+		"anthropic-ratelimit-unified-7d-utilization":       "0.25",
+		"anthropic-ratelimit-unified-7d-reset":             strconv.FormatInt(week, 10),
+	}
+	for _, stream := range []bool{true, false} {
+		t.Run("rate_limit_event/stream="+strconv.FormatBool(stream), func(t *testing.T) {
+			rec := ask(provider.Anthropic, owner, stream, []string{rejectedEvent, refusal})
+			for k, v := range want {
+				if got := rec.Header().Get(k); got != v {
+					t.Errorf("%s: %q, want %q (headers %v)", k, got, v, rec.Header())
+				}
+			}
+		})
+	}
+
+	t.Run("non-anthropic client gets no unified rejection header", func(t *testing.T) {
+		rec := ask(provider.Chat, owner, true, []string{rejectedEvent, refusal})
+		if got := rec.Header().Get("anthropic-ratelimit-unified-status"); got != "" {
+			t.Errorf("chat client got unified status %q", got)
+		}
+	})
+
+	t.Run("plain rate-limit 429 without rejected event stays plain", func(t *testing.T) {
+		freshOwner := "claude\x00plain-" + strconv.FormatInt(time.Now().UnixNano(), 36) + "@example.com"
+		plain := `{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"This request would exceed your account's rate limit. Please try again later."}`
+		rec := ask(provider.Anthropic, freshOwner, true, []string{plain})
+		if got := rec.Header().Get("anthropic-ratelimit-unified-status"); got != "" {
+			t.Errorf("plain rate-limit got unified status %q (headers %v)", got, rec.Header())
+		}
+	})
+
+	t.Run("refusal text fallback when no rate_limit_event arrived", func(t *testing.T) {
+		taipei, err := time.LoadLocation("Asia/Taipei")
+		if err != nil {
+			t.Fatal(err)
+		}
+		target := time.Now().In(taipei).Add(90 * time.Minute).Truncate(time.Minute)
+		clock := strings.ToLower(target.Format("3:04pm"))
+		textOnly := `{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"You've hit your 5-hour limit · resets ` + clock + ` (Asia/Taipei)"}`
+		textOwner := "claude\x00text-" + strconv.FormatInt(time.Now().UnixNano(), 36) + "@example.com"
+		rec := ask(provider.Anthropic, textOwner, true, []string{textOnly})
+		if got := rec.Header().Get("anthropic-ratelimit-unified-status"); got != "rejected" {
+			t.Fatalf("status %q, want rejected (headers %v)", got, rec.Header())
+		}
+		if got := rec.Header().Get("anthropic-ratelimit-unified-representative-claim"); got != "five_hour" {
+			t.Fatalf("claim %q, want five_hour", got)
+		}
+		if got := rec.Header().Get("anthropic-ratelimit-unified-reset"); got != strconv.FormatInt(target.Unix(), 10) {
+			t.Fatalf("reset %q, want %d", got, target.Unix())
+		}
+	})
+}
+
+// Through the full gateway, a Claude subscription 429 passes the unified
+// rejection headers past holdWriter without leaking internal notes, and
+// keepRetry preserves upstream anthropic-ratelimit-unified-* headers on 429s.
+func TestClaude429UnifiedHeadersThroughGatewayAndKeepRetry(t *testing.T) {
+	t.Run("keepRetry preserves unified rejection headers", func(t *testing.T) {
+		reset := strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10)
+		src := http.Header{
+			"Anthropic-Ratelimit-Unified-Status":               {"rejected"},
+			"Anthropic-Ratelimit-Unified-Reset":                {reset},
+			"Anthropic-Ratelimit-Unified-Representative-Claim": {"seven_day"},
+			"Anthropic-Ratelimit-Unified-Overage-Status":       {"rejected"},
+			"Anthropic-Ratelimit-Unified-7d-Utilization":       {"1"},
+			"Anthropic-Ratelimit-Unified-7d-Reset":             {reset},
+		}
+		dst := http.Header{}
+		keepRetry(dst, src, nil)
+		for k, vs := range src {
+			if got := dst.Get(k); got != vs[0] {
+				t.Errorf("%s: %q, want %q", k, got, vs[0])
+			}
+		}
+	})
+
+	t.Run("multi-account pool clamps unified reset to soonest account back", func(t *testing.T) {
+		fresh(t)
+		now := time.Now()
+		soon := now.Add(25 * time.Minute).Unix()
+		later := now.Add(3 * time.Hour).Unix()
+
+		upA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+			w.Header().Set("Content-Type", "application/json")
+			w.Header().Set("Anthropic-Ratelimit-Unified-Status", "rejected")
+			w.Header().Set("Anthropic-Ratelimit-Unified-Reset", strconv.FormatInt(soon, 10))
+			w.Header().Set("Anthropic-Ratelimit-Unified-Representative-Claim", "five_hour")
+			w.WriteHeader(http.StatusTooManyRequests)
+			io.WriteString(w, `{"type":"error","error":{"type":"rate_limit_error","message":"You've hit your 5-hour limit"}}`)
+		}))
+		defer upA.Close()
+		upB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+			w.Header().Set("Content-Type", "application/json")
+			w.Header().Set("Anthropic-Ratelimit-Unified-Status", "rejected")
+			w.Header().Set("Anthropic-Ratelimit-Unified-Reset", strconv.FormatInt(later, 10))
+			w.Header().Set("Anthropic-Ratelimit-Unified-Representative-Claim", "five_hour")
+			w.WriteHeader(http.StatusTooManyRequests)
+			io.WriteString(w, `{"type":"error","error":{"type":"rate_limit_error","message":"You've hit your 5-hour limit"}}`)
+		}))
+		defer upB.Close()
+
+		for _, p := range []provider.Provider{
+			{ID: "anth-a", Name: "Anth A", Key: "ka", Anthropic: upA.URL, Models: []string{"claude-sonnet-5"}},
+			{ID: "anth-b", Name: "Anth B", Key: "kb", Anthropic: upB.URL, Models: []string{"claude-sonnet-5"}},
+		} {
+			if err := provider.Save(p); err != nil {
+				t.Fatal(err)
+			}
+		}
+		if err := provider.SaveGroup(provider.Group{
+			ID:      "g-cl",
+			Name:    "G CL",
+			Routing: "order",
+			Members: []string{"anth-a/claude-sonnet-5", "anth-b/claude-sonnet-5"},
+		}); err != nil {
+			t.Fatal(err)
+		}
+
+		s := New()
+		srv := httptest.NewServer(s.Handler())
+		defer srv.Close()
+		res, err := http.Post(srv.URL+"/v1/messages", "application/json", strings.NewReader(
+			`{"model":"group/g-cl","max_tokens":50,"messages":[{"role":"user","content":"hi"}]}`))
+		if err != nil {
+			t.Fatal(err)
+		}
+		res.Body.Close()
+		if res.StatusCode != http.StatusTooManyRequests {
+			t.Fatalf("status %d, want 429", res.StatusCode)
+		}
+		if got := res.Header.Get("anthropic-ratelimit-unified-status"); got != "rejected" {
+			t.Fatalf("status %q, want rejected (headers %v)", got, res.Header)
+		}
+		if got := res.Header.Get("anthropic-ratelimit-unified-representative-claim"); got != "five_hour" {
+			t.Fatalf("claim %q, want five_hour", got)
+		}
+		gotReset, err := strconv.ParseInt(res.Header.Get("anthropic-ratelimit-unified-reset"), 10, 64)
+		if err != nil {
+			t.Fatalf("reset header %q: %v", res.Header.Get("anthropic-ratelimit-unified-reset"), err)
+		}
+		if diff := gotReset - soon; diff < -5 || diff > 5 {
+			t.Fatalf("unified reset %d, want ~%d (soonest account, not later %d)", gotReset, soon, later)
+		}
+		if res.Header.Get(resetsHeader) != "" {
+			t.Fatalf("leaked internal header %s=%q", resetsHeader, res.Header.Get(resetsHeader))
+		}
+	})
+
+	t.Run("claude subscription 429 through gateway passes unified headers", func(t *testing.T) {
+		if runtime.GOOS == "windows" {
+			t.Skip("a shell script stands in for Claude Code")
+		}
+		home := t.TempDir()
+		t.Setenv("HOME", home)
+		t.Setenv("USERPROFILE", home)
+		t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
+		t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
+		os.MkdirAll(filepath.Join(home, ".claude"), 0o755)
+		os.WriteFile(filepath.Join(home, ".claude", ".credentials.json"), mustJSON(map[string]any{"claudeAiOauth": map[string]any{
+			"accessToken": "tok-me", "refreshToken": "r-me", "expiresAt": time.Now().Add(24 * time.Hour).UnixMilli(), "subscriptionType": "pro"}}), 0o600)
+		os.WriteFile(filepath.Join(home, ".claude.json"), mustJSON(map[string]any{
+			"oauthAccount": map[string]any{"emailAddress": "rej-gw@example.com", "accountUuid": "u-rej"}}), 0o600)
+		five := strconv.FormatInt(time.Now().Add(2*time.Hour).Unix(), 10)
+		dir := t.TempDir()
+		testenv.Program(t, filepath.Join(dir, "claude"), `#!/bin/sh
+if [ "$1" = auth ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"rej-gw@example.com","subscriptionType":"pro"}'; exit 0; fi
+while read -r line; do
+  echo '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","resetsAt":`+five+`,"overageStatus":"rejected","unifiedWindows":{"five_hour":{"utilization":1,"resetsAt":`+five+`}}}}'
+  echo '{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"You'\''ve hit your 5-hour limit · resets 1:20pm (Asia/Taipei)"}'
+done
+`)
+		t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
+		provider.ForgetAccounts()
+		t.Cleanup(provider.ForgetAccounts)
+		s := New()
+		t.Cleanup(s.subscription.abortAll)
+		srv := httptest.NewServer(s.Handler())
+		defer srv.Close()
+		for _, stream := range []string{"true", "false"} {
+			res, err := http.Post(srv.URL+"/v1/messages", "application/json", strings.NewReader(
+				`{"model":"claude/claude-sonnet-5","max_tokens":50,"stream":`+stream+`,"messages":[{"role":"user","content":"ping `+stream+`"}]}`))
+			if err != nil {
+				t.Fatal(err)
+			}
+			b, _ := io.ReadAll(res.Body)
+			res.Body.Close()
+			if res.StatusCode != http.StatusTooManyRequests {
+				t.Fatalf("stream=%s: %d %s", stream, res.StatusCode, b)
+			}
+			for k, v := range map[string]string{
+				"anthropic-ratelimit-unified-status":               "rejected",
+				"anthropic-ratelimit-unified-reset":                five,
+				"anthropic-ratelimit-unified-representative-claim": "five_hour",
+				"anthropic-ratelimit-unified-overage-status":       "rejected",
+				"anthropic-ratelimit-unified-5h-reset":             five,
+			} {
+				if got := res.Header.Get(k); got != v {
+					t.Errorf("stream=%s: %s %q, want %q (headers %v)", stream, k, got, v, res.Header)
+				}
+			}
+			if res.Header.Get(resetsHeader) != "" {
+				t.Errorf("stream=%s: leaked %s=%q", stream, resetsHeader, res.Header.Get(resetsHeader))
+			}
+		}
+	})
+}
diff --git a/internal/gateway/claude_subscription.go b/internal/gateway/claude_subscription.go
index c4d64a3c1..7bc896dde 100644
--- a/internal/gateway/claude_subscription.go
+++ b/internal/gateway/claude_subscription.go
@@ -4445,7 +4445,8 @@ func (r *subscriptionRun) readOutput(rd io.Reader) {
 	retell := false      // the run is told to make its calls once this turn's result is in
 	answerAsked := false // the interactive mode's turn was asked for its answer tool's call
 	retold := false      // this reply was told so
-	var pmu sync.Mutex   // held for each line, and by quiet's settle
+	var rejected *rejectedLimit
+	var pmu sync.Mutex // held for each line, and by quiet's settle
 	var quiet *time.Timer
 	text := func(s string) {
 		if s != "" && !r.schema {
@@ -4787,6 +4788,9 @@ func (r *subscriptionRun) readOutput(rd io.Reader) {
 			if user, own := ownerAccount(r.owned()); user != "" && !(own && provider.ClaudeCodeMovedOff(user)) {
 				provider.NoteClaudeLimits(user, claudeLimits(envelope.RateLimitInfo))
 			}
+			if rej, seen := claudeRejectedLimit(envelope.RateLimitInfo); seen {
+				rejected = rej
+			}
 			return
 		}
 		if envelope.Type == "result" && retell && !envelope.IsError {
@@ -4820,6 +4824,8 @@ func (r *subscriptionRun) readOutput(rd io.Reader) {
 		}
 		if envelope.Type == "result" {
 			retell, answerAsked = false, false
+			rej := rejected
+			rejected = nil
 			silent, said := !begun, aside
 			begun, aside = false, ""
 			// a turn that failed — out of quota, rate limited — ends with
@@ -4852,7 +4858,7 @@ func (r *subscriptionRun) readOutput(rd io.Reader) {
 					!(own && provider.ClaudeCodeMovedOff(user)) {
 					provider.NoteClaudeSignInFailure(user, r.loginVersion, text)
 				}
-				r.emit(Event{Kind: KError, Text: text, Status: envelope.APIErrorStatus, Code: errKind, RequestID: reqID})
+				r.emit(Event{Kind: KError, Text: text, Status: envelope.APIErrorStatus, Code: errKind, RequestID: reqID, Rejected: rej})
 				r.endSegment()
 			case cut:
 				failed("and Claude Code ended the turn without asking again")
@@ -5177,6 +5183,50 @@ func claudeLimits(raw json.RawMessage) []provider.ClaudeLimit {
 	return out
 }
 
+// claudeRejectedLimit extracts a rejected unified rate-limit claim and reset
+// from a rate_limit_event's rate_limit_info. seen is true whenever status was
+// present, so a subsequent "allowed" event clears an earlier rejection.
+func claudeRejectedLimit(raw json.RawMessage) (*rejectedLimit, bool) {
+	type window struct {
+		Status      string  `json:"status"`
+		Utilization float64 `json:"utilization"`
+		ResetsAt    int64   `json:"resetsAt"`
+	}
+	var info struct {
+		Status         string            `json:"status"`
+		RateLimitType  string            `json:"rateLimitType"`
+		ResetsAt       int64             `json:"resetsAt"`
+		OverageStatus  string            `json:"overageStatus"`
+		UnifiedWindows map[string]window `json:"unifiedWindows"`
+	}
+	if json.Unmarshal(raw, &info) != nil || info.Status == "" {
+		return nil, false
+	}
+	if info.Status != "rejected" {
+		return nil, true
+	}
+	claim, at := info.RateLimitType, info.ResetsAt
+	if at <= 0 && claim != "" {
+		at = info.UnifiedWindows[claim].ResetsAt
+	}
+	if claim == "" || at <= 0 {
+		for _, kind := range []string{"five_hour", "seven_day", "seven_day_overage_included", "seven_day_opus", "seven_day_sonnet"} {
+			w, ok := info.UnifiedWindows[kind]
+			if !ok || (w.Status != "rejected" && w.Utilization < 1) {
+				continue
+			}
+			if claim == "" {
+				claim = kind
+			}
+			if at <= 0 && w.ResetsAt > 0 {
+				at = w.ResetsAt
+			}
+			break
+		}
+	}
+	return &rejectedLimit{claim: claim, resetsAt: at, overageStatus: info.OverageStatus}, true
+}
+
 // carryUpdate keeps this message's known 1h writes when a partial split
 // reports only 5m counts, then adds usage from earlier messages
 // (after).
@@ -7373,6 +7423,163 @@ var ratelimitWindows = map[string]string{
 	"seven_day_overage_included": "7d_oi",
 }
 
+// claudeResetText reads the reset time written in a Claude Code usage-limit
+// refusal such as "You've hit your 5-hour limit · resets 1:20pm (Asia/Taipei)"
+// or "You've hit your weekly limit · resets Oct 9, 2:59pm (UTC)".
+var claudeResetText = lazyre.New(`(?i)\bresets\s+([^()\r\n·]+(?:\([^()\r\n]+\))?)`)
+
+// claudeMonthWord distinguishes a weekly date-and-time reset ("Oct 9, 2:59pm")
+// from a 5-hour clock-only reset ("1:20pm (Asia/Taipei)").
+var claudeMonthWord = lazyre.New(`(?i)\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b`)
+
+func claudeClaimFromText(msg string) string {
+	l := strings.ToLower(msg)
+	switch {
+	case strings.Contains(l, "5-hour"), strings.Contains(l, "5 hour"),
+		strings.Contains(l, "five-hour"), strings.Contains(l, "five hour"),
+		strings.Contains(l, "session limit"):
+		return "five_hour"
+	case strings.Contains(l, "weekly"), strings.Contains(l, "7-day"),
+		strings.Contains(l, "7 day"), strings.Contains(l, "seven-day"),
+		strings.Contains(l, "seven day"):
+		return "seven_day"
+	case strings.Contains(l, "fable limit"):
+		return "seven_day_overage_included"
+	case strings.Contains(l, "opus limit"):
+		return "seven_day_opus"
+	case strings.Contains(l, "sonnet limit"):
+		return "seven_day_sonnet"
+	}
+	return ""
+}
+
+func claudeClaimSpan(claim string) time.Duration {
+	switch {
+	case claim == "five_hour":
+		return 5 * time.Hour
+	case strings.HasPrefix(claim, "seven_day"):
+		return 7 * 24 * time.Hour
+	}
+	return 0
+}
+
+// rejectedLimitHeaders writes Anthropic's unified rejection headers on a
+// Claude subscription 429 so a downstream Claude Code signed in to claude.ai
+// (including T3 Code's claudeAgent) emits rate_limit_event and
+// api_error_params.rate_limit_info with resetsAt and can auto-resume.
+func rejectedLimitHeaders(w http.ResponseWriter, from provider.Protocol, owner, msg string, rej *rejectedLimit, now time.Time) {
+	if rej == nil && !quotaSaid(msg) {
+		return
+	}
+	var claim, overage string
+	var at int64
+	if rej != nil {
+		claim, at, overage = rej.claim, rej.resetsAt, rej.overageStatus
+	}
+	if claim == "" {
+		claim = claudeClaimFromText(msg)
+	}
+	if at <= now.Unix() {
+		if user, own := ownerAccount(owner); user != "" && !(own && provider.ClaudeCodeMovedOff(user)) {
+			var best provider.ClaudeLimit
+			for _, l := range provider.KeptClaudeLimits(user) {
+				if l.Used < 1 || l.ResetsAt <= now.Unix() {
+					continue
+				}
+				if claim != "" && l.Kind == claim {
+					best = l
+					break
+				}
+				if l.ResetsAt > best.ResetsAt {
+					best = l
+				}
+			}
+			if best.ResetsAt > now.Unix() {
+				at = best.ResetsAt
+				if claim == "" {
+					claim = best.Kind
+				}
+			}
+		}
+	}
+	if at <= now.Unix() {
+		if d := resetsAt([]byte(msg), now); d > 0 {
+			at = now.Add(d).Unix()
+			if claim == "" {
+				if d <= 7*time.Hour {
+					claim = "five_hour"
+				} else {
+					claim = "seven_day"
+				}
+			}
+		}
+	}
+	if at <= now.Unix() {
+		if m := claudeResetText.FindStringSubmatch(msg); m != nil {
+			clock := strings.TrimRight(strings.TrimSpace(m[1]), ".,;")
+			span := claudeClaimSpan(claim)
+			if span == 0 {
+				if claudeMonthWord.MatchString(clock) {
+					span, claim = 7*24*time.Hour, "seven_day"
+				} else {
+					span, claim = 5*time.Hour, "five_hour"
+				}
+			}
+			if t, ok := provider.ClaudeResetTime(clock, now, span); ok && t.After(now) {
+				at = t.Unix()
+			}
+		}
+	}
+	if at <= now.Unix() || claim == "" {
+		return
+	}
+	resetStr := strconv.FormatInt(at, 10)
+	if hw, ok := w.(*holdWriter); ok {
+		hw.note(resetsHeader, resetStr)
+	}
+	if from != provider.Anthropic {
+		return
+	}
+	set := func(k, v string) {
+		if hw, ok := w.(*holdWriter); ok {
+			hw.note(k, v)
+		} else {
+			w.Header().Set(k, v)
+		}
+	}
+	set("anthropic-ratelimit-unified-status", "rejected")
+	set("anthropic-ratelimit-unified-reset", resetStr)
+	set("anthropic-ratelimit-unified-representative-claim", claim)
+	if overage != "" {
+		set("anthropic-ratelimit-unified-overage-status", overage)
+	}
+	if win, ok := ratelimitWindows[claim]; ok {
+		set("anthropic-ratelimit-unified-"+win+"-status", "rejected")
+		set("anthropic-ratelimit-unified-"+win+"-utilization", "1")
+		set("anthropic-ratelimit-unified-"+win+"-reset", resetStr)
+	}
+}
+
+// replayUnifiedRejectedHeaders writes a resting candidate's saved
+// anthropic-ratelimit-unified-* rejection headers onto a held 429 reply
+// (timedHeld / quotaHeld), clamping the top-level reset to back when another
+// resting candidate in the pool recovers sooner.
+func replayUnifiedRejectedHeaders(hw *holdWriter, saved http.Header, back, now time.Time) {
+	if !strings.EqualFold(saved.Get("anthropic-ratelimit-unified-status"), "rejected") {
+		return
+	}
+	for k, vs := range saved {
+		if len(vs) > 0 && strings.HasPrefix(strings.ToLower(k), "anthropic-ratelimit-unified-") {
+			hw.note(k, vs[0])
+		}
+	}
+	if back.After(now) {
+		if at, err := strconv.ParseInt(saved.Get("anthropic-ratelimit-unified-reset"), 10, 64); err != nil || at > back.Unix() {
+			hw.note("anthropic-ratelimit-unified-reset", strconv.FormatInt(back.Unix(), 10))
+		}
+	}
+}
+
 // serveSubscription answers a request through an agent's own binary: a new
 // turn starts it, a request carrying tool results resumes the turn waiting
 // on them.
@@ -7711,9 +7918,16 @@ func (s *Server) serveSubscriptionAs(w http.ResponseWriter, r *http.Request, fro
 	// the allowance as kept now, and again as the reply begins, its turn
 	// having told it by then
 	var begin func()
+	var onLimit func(code int, msg string, rej *rejectedLimit)
 	if name == "Claude Code" {
 		limitHeaders(w, owner)
 		begin = func() { limitHeaders(w, owner) }
+		onLimit = func(code int, msg string, rej *rejectedLimit) {
+			if code == http.StatusTooManyRequests {
+				limitHeaders(w, owner)
+				rejectedLimitHeaders(w, from, owner, msg, rej, time.Now())
+			}
+		}
 	}
 	run.mu.Lock()
 	req.interactive = run.tui
@@ -7723,7 +7937,7 @@ func (s *Server) serveSubscriptionAs(w http.ResponseWriter, r *http.Request, fro
 		defer close(quit)
 		events = keepBridgeHeard(events, quit)
 	}
-	code, msg := relayFailing(w, r, from, name, req, events, usage, abort, begin, func(said, stop string, ok bool) {
+	code, msg := relayFailing(w, r, from, name, req, events, usage, abort, begin, onLimit, func(said, stop string, ok bool) {
 		if !gone() {
 			return // the client went first: letGo has the run
 		}
@@ -8050,13 +8264,14 @@ func keepBridgeHeard(events <-chan Event, quit <-chan struct{}) <-chan Event {
 // event goes out.
 func relay(w http.ResponseWriter, r *http.Request, from provider.Protocol, name string, req *Request, events <-chan Event, usage *Usage,
 	abort, begin func(), ended func(said, stop string, ok bool)) (int, string) {
-	return relayFailing(w, r, from, name, req, events, usage, func(int, string) { abort() }, begin, ended)
+	return relayFailing(w, r, from, name, req, events, usage, func(int, string) { abort() }, begin, nil, ended)
 }
 
 // relayFailing is relay with abort told the status and words the client
-// is answered with (bridgeFailed).
+// is answered with (bridgeFailed), and onLimit told a failure's rejected
+// rate-limit info before the error response is written.
 func relayFailing(w http.ResponseWriter, r *http.Request, from provider.Protocol, name string, req *Request, events <-chan Event, usage *Usage,
-	abort func(code int, msg string), begin func(), ended func(said, stop string, ok bool)) (int, string) {
+	abort func(code int, msg string), begin func(), onLimit func(code int, msg string, rej *rejectedLimit), ended func(said, stop string, ok bool)) (int, string) {
 	stream := req.Stream
 	if stream {
 		// an error before any of the answer — out of quota, rate limited —
@@ -8101,6 +8316,13 @@ func relayFailing(w http.ResponseWriter, r *http.Request, from provider.Protocol
 				usage.add(Usage{ErrType: head[n-1].Code, RequestID: head[n-1].RequestID})
 				msg = thirdPartyRefused(name, req, code, msg)
 			}
+			if onLimit != nil {
+				var rej *rejectedLimit
+				if n > 0 {
+					rej = head[n-1].Rejected
+				}
+				onLimit(code, msg, rej)
+			}
 			return writeError(w, from, code, name+": "+msg), msg
 		}
 		if begin != nil {
@@ -8187,6 +8409,9 @@ func relayFailing(w http.ResponseWriter, r *http.Request, from provider.Protocol
 		}
 		usage.add(Usage{ErrType: col.errCode})
 		msg = thirdPartyRefused(name, req, code, msg)
+		if onLimit != nil {
+			onLimit(code, msg, col.errRejected)
+		}
 		return writeError(w, from, code, name+": "+msg), msg
 	}
 	ended(said, stop, col.err == "" && r.Context().Err() == nil)
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index 2a9186956..429d910d5 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -4544,6 +4544,9 @@ func (s *Server) serve(w http.ResponseWriter, r *http.Request, from provider.Pro
 			// the answer names who held it, as one asked would: a magpie
 			// using this one rests that model of it alone (remoteModelRest)
 			noteMember(hw, r, c.p, c.model)
+			if from == provider.Anthropic && rested.outHeader != nil {
+				replayUnifiedRejectedHeaders(hw, rested.outHeader, back, time.Now())
+			}
 			writeError(hw, from, call.Status, msg)
 		} else if rested, back, ok := timedHeld(cands[i:]); ok && last {
 			// it rests on a 429 till the time its vendor named, and so
@@ -4575,6 +4578,9 @@ func (s *Server) serve(w http.ResponseWriter, r *http.Request, from provider.Pro
 				// (TestCodexEveryAccountOutToldAsTheBackend)
 				writeCodexOut(hw, rested.outHeader, call.Status, msg, rested.out)
 			} else {
+				if from == provider.Anthropic && rested.outHeader != nil {
+					replayUnifiedRejectedHeaders(hw, rested.outHeader, back, time.Now())
+				}
 				writeError(hw, from, call.Status, msg)
 			}
 		} else {
@@ -5856,14 +5862,25 @@ func (s *Server) serve(w http.ResponseWriter, r *http.Request, from provider.Pro
 			rest := s.restAfterMarked(c, hw.code(), hw.header, hw.errBody(), hw.sharedPool)
 			try.Fail, try.Rest = rest.Why, &rest
 		}
-		if !hw.passing && hw.code() == http.StatusTooManyRequests && hw.header.Get("Retry-After") == "" {
-			// the vendor said nothing of when: the agent is told when
-			// magpie asks again, the first of those it rested back
+		if !hw.passing && hw.code() == http.StatusTooManyRequests {
 			if heldBack.IsZero() {
 				heldBack, _ = soonestBack(cands[:i+1])
 			}
-			if wait := time.Until(heldBack); wait > 0 {
-				w.Header().Set("Retry-After", strconv.Itoa(int((wait+time.Second-1)/time.Second)))
+			now := time.Now()
+			if hw.header.Get("Retry-After") == "" {
+				// the vendor said nothing of when: the agent is told when
+				// magpie asks again, the first of those it rested back
+				if wait := heldBack.Sub(now); wait > 0 {
+					w.Header().Set("Retry-After", strconv.Itoa(int((wait+time.Second-1)/time.Second)))
+				}
+			}
+			// Across a multi-account pool where every account is spent, tell a
+			// Claude client the soonest account back rather than only the last
+			// candidate's reset.
+			if i > 0 && from == provider.Anthropic && hw.header.Get("anthropic-ratelimit-unified-status") == "rejected" && heldBack.After(now) {
+				if at, err := strconv.ParseInt(hw.header.Get("anthropic-ratelimit-unified-reset"), 10, 64); err != nil || at > heldBack.Unix() {
+					hw.note("anthropic-ratelimit-unified-reset", strconv.FormatInt(heldBack.Unix(), 10))
+				}
 			}
 		}
 		if hw.refused && !hw.passing && from == provider.Anthropic && hw.handBack() {
diff --git a/internal/gateway/ir.go b/internal/gateway/ir.go
index 0c03e4ab1..e77e844ac 100644
--- a/internal/gateway/ir.go
+++ b/internal/gateway/ir.go
@@ -496,6 +496,14 @@ const (
 	KAdvice
 )
 
+// rejectedLimit is the rejected unified rate-limit claim and reset a Claude
+// subscription run reported in its rate_limit_event before failing with 429.
+type rejectedLimit struct {
+	claim         string
+	resetsAt      int64
+	overageStatus string
+}
+
 // Event is one thing a streaming reply said.
 type Event struct {
 	Kind   EventKind
@@ -511,6 +519,7 @@ type Event struct {
 	// request the event is of, when it is known by then
 	Code             string
 	RequestID        string
+	Rejected         *rejectedLimit
 	Usage            Usage
 	Hits             []Hit
 	SafeguardResults json.RawMessage
@@ -737,9 +746,10 @@ type collector struct {
 	fresh bool
 	err   string
 	// the error's status and kind, as its event gave them
-	errStatus int
-	errCode   string
-	errSaid   json.RawMessage
+	errStatus   int
+	errCode     string
+	errSaid     json.RawMessage
+	errRejected *rejectedLimit
 }
 
 func (c *collector) last(k Kind) *Part {
@@ -862,7 +872,7 @@ func (c *collector) add(ev Event) {
 			c.res.Model = ev.Model // another model went on with the reply
 		}
 	case KError:
-		c.err, c.errStatus, c.errCode, c.errSaid = ev.Text, ev.Status, ev.Code, ev.Said
+		c.err, c.errStatus, c.errCode, c.errSaid, c.errRejected = ev.Text, ev.Status, ev.Code, ev.Said, ev.Rejected
 	case KSearch:
 		c.closeTool()
 		c.res.Parts = append(c.res.Parts, Part{Kind: Search, Text: ev.Text, Hits: ev.Hits})
diff --git a/internal/gateway/routing.go b/internal/gateway/routing.go
index 05b54915d..a6fd5ca40 100644
--- a/internal/gateway/routing.go
+++ b/internal/gateway/routing.go
@@ -1681,6 +1681,13 @@ func (s *Server) restAfterMarked(c candidate, status int, header http.Header, bo
 				r.outHeader[k] = slices.Clone(vs)
 			}
 		}
+	} else if status == http.StatusTooManyRequests && strings.EqualFold(header.Get("anthropic-ratelimit-unified-status"), "rejected") {
+		r.outHeader = http.Header{}
+		for k, vs := range header {
+			if strings.HasPrefix(strings.ToLower(k), "anthropic-ratelimit-unified-") {
+				r.outHeader[k] = slices.Clone(vs)
+			}
+		}
 	}
 	switch why {
 	case failCredit:
@@ -2451,7 +2458,7 @@ func (c candidate) allowance() (provider.Allowance, bool) {
 func keepRetry(dst, src http.Header, body []byte) {
 	for k, vs := range src {
 		l := strings.ToLower(k)
-		if l == "retry-after" || strings.Contains(l, "ratelimit") && strings.Contains(l, "reset") {
+		if l == "retry-after" || strings.HasPrefix(l, "anthropic-ratelimit-unified-") || strings.Contains(l, "ratelimit") && strings.Contains(l, "reset") {
 			dst[k] = vs
 		}
 	}
diff --git a/internal/provider/claude_usage_cli.go b/internal/provider/claude_usage_cli.go
index ca50e5adf..e83f55e97 100644
--- a/internal/provider/claude_usage_cli.go
+++ b/internal/provider/claude_usage_cli.go
@@ -333,6 +333,13 @@ func clipReason(s string) string {
 	return s
 }
 
+// ClaudeResetTime parses a Claude Code reset clock string such as
+// "1:20pm (Asia/Taipei)" or "Oct 9, 2:59pm (UTC)" relative to now for a
+// window of length span.
+func ClaudeResetTime(s string, now time.Time, span time.Duration) (time.Time, bool) {
+	return claudeResetTime(s, now, span)
+}
+
 // claudeResetTime reads "Oct 1 at 3:30pm (Asia/Shanghai)", "Oct 9, 2:59pm
 // (UTC)" (Claude Code 2.1.285 on) or "3pm (Asia/Shanghai)", in the zone
 // named, else local time. It ends a window span long, so it is never further
-- 
2.50.1 (Apple Git-155)


From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: Yukai Huang <yukaihuangtw@gmail.com>
Date: Sat, 21 Nov 2026 13:47:30 +0800
Subject: [PATCH 2/2] agent: T3 Code can keep Claude Code's claude.ai sign-in

T3 Code's magpie provider instance runs Claude Code (claudeAgent). When
ANTHROPIC_AUTH_TOKEN is set to magpie's key, Claude Code ignores
anthropic-ratelimit-unified-* response headers, so status lines and T3
Code's usage-limit auto-resume never receive resetsAt.

Add the sign-in (login) field to the t3code agent, matching claude's
login=claudeai option: when set to claudeai on a local gateway,
providerInstances.magpie sets ANTHROPIC_AUTH_TOKEN to an empty string so
Claude Code keeps its claude.ai sign-in while routing through magpie.
Sync, reconnect and Check all preserve it.

Verified:
- Red before fix: TestT3CodeKeepsItsClaudeAISignIn failed with
  "T3 Code has no sign-in field".
- Green after fix with -race: go test -tags nogui -race ./internal/agent
  -run 'TestT3Code|TestEveryFieldLabelHasTUIZh|TestFolderVarsAreListed'
  and go test -tags nogui ./internal/gui -run 'TestStateListsT3Code'.
---
 docs/reference.md                 |   2 +-
 internal/agent/t3code.go          |  65 ++++++++++++++++--
 internal/agent/t3code_test.go     | 108 ++++++++++++++++++++++++++++++
 internal/gui/t3code_state_test.go |   4 +-
 4 files changed, 172 insertions(+), 7 deletions(-)

diff --git a/docs/reference.md b/docs/reference.md
index e2738c36d..fc906a57d 100644
--- a/docs/reference.md
+++ b/docs/reference.md
@@ -163,7 +163,7 @@ line; agents connected to magpie lose it when it quits.
 | Tuanjie Cowork | `~/.codely/settings.json` | model (a `magpie` entry in `customModelProviders`, the gateway's `/v1` with Cowork's own key, and a `magpie` entry in `customModels` on `wireApi` `chat`; the user's providers and models kept; pick "<model> (magpie)" in Cowork's model menu once, restarting Cowork if it isn't listed yet) |
 | NewMax       | `newmax.db` (SQLite, the row `app` of its `settings` table) in `$NEWMAX_USER_DATA_DIR`, else `~/.newmax` (every OS) | provider (a `magpie-gateway` entry in its `providers` and `providerOrder`, magpie's models in its model picker; the rest of the row kept byte for byte; refused while NewMax runs, as it writes its settings back whenever one changes) |
 | LiveAgent    | `config.json` (JSONC, K-brain's) in `$LIVEAGENT_HOME`, else `$K_BRAIN_HOME`, else the folder `~/.liveagent/data-dir.json` points to, else `~/.liveagent` (every OS) | provider (`magpie`, `magpie-responses` and `magpie-anthropic` entries in its `providers`, each model on the one of the API it is served on natively: Chat Completions and Responses at the gateway's `/v1` as OpenAI providers whose request format the user can switch in LiveAgent and magpie keeps, Anthropic Messages at its root; magpie's models in its model picker; a model or provider of magpie's deleted in LiveAgent stays out; a default still K-brain's own demo model becomes magpie's first; refused while LiveAgent or its `k-brain` backend runs, as it writes its settings back whenever one changes) |
-| T3 Code      | `~/.t3/userdata/settings.json` (`$T3CODE_HOME/userdata`) | provider (a `magpie` provider instance on Claude Code, magpie's models as its custom models; a `magpie-codex` instance on Codex, whose `launchArgs` are Codex's own `-c` overrides to magpie and a `magpie-codex-models.json` catalog beside the settings. The harness is picked in T3's model picker) |
+| T3 Code      | `~/.t3/userdata/settings.json` (`$T3CODE_HOME/userdata`) | provider, sign-in (a `magpie` provider instance on Claude Code, magpie's models as its custom models, with `claudeai` sign-in keeping `ANTHROPIC_AUTH_TOKEN` empty so Claude Code keeps its `claude.ai` login; a `magpie-codex` instance on Codex, whose `launchArgs` are Codex's own `-c` overrides to magpie and a `magpie-codex-models.json` catalog beside the settings. The harness is picked in T3's model picker) |
 | OpenMausBot  | `~/.openmausbot/config.json` (`$OMB_DATA_DIR`) | provider (a `magpie` engine in `instances`: OpenMausBot's own Claude endpoint shape, Claude Code with `ANTHROPIC_BASE_URL` at the gateway and magpie's models as its `endpointModels`, in its own `CLAUDE_CONFIG_DIR` under `providers/magpie`. With no `instances` saved, OpenMausBot's default engines are written beside it. OpenMausBot reads it when it starts) |
 | Avibe        | `~/.avibe/config/config.json` (`$AVIBE_HOME`; `~/.vibe_remote` from before 3.0), changed through its control socket `state/dispatch.sock` (Windows: `runtime/control-ipc/endpoint.json`) while it runs | provider (a `magpie` model source on its Models page: custom vendor, OpenAI chat completions at the gateway's `/v1`, with Avibe's own key; Avibe lists magpie's models from the gateway and adds the source to Vibey's, Claude Code's, Codex's and OpenCode's routes. Avibe has to be running to connect or disconnect it) |
 | Kun          | `~/.kun/data/model-connections.v2.json` (`$KUN_DATA_DIR`), changed through its runtime's admin API (`baseUrl` and `runtimeToken` of `runtime.json` in the same folder) while it runs | model (a `magpie` connection in Settings > Providers: HTTP, OpenAI chat completions at the gateway's `/v1`, with Kun's own key and the models picked for Kun; the model picked is Kun's default. Kun has to be running to connect or disconnect it) |
diff --git a/internal/agent/t3code.go b/internal/agent/t3code.go
index 736176067..0c216f03a 100644
--- a/internal/agent/t3code.go
+++ b/internal/agent/t3code.go
@@ -53,6 +53,7 @@ import (
 	"bytes"
 	"encoding/json"
 	"errors"
+	"fmt"
 	"io/fs"
 	"os"
 	"path/filepath"
@@ -80,6 +81,13 @@ const (
 // T3, and a sync doesn't bring it back.
 const t3CodexOffered = "t3code.codex"
 
+// t3Login is the stash key for how T3 Code's magpie Claude Code instance signs
+// in to the gateway: "" for magpie's key, or "claudeai" to leave
+// ANTHROPIC_AUTH_TOKEN empty so Claude Code keeps its claude.ai sign-in (and
+// reads anthropic-ratelimit-unified-* headers for status lines and T3 Code
+// usage-limit auto-resume).
+const t3Login = "t3code.login"
+
 // t3Base is T3 Code's folder for home: $T3CODE_HOME, else ~/.t3. Its
 // settings are userdata/settings.json in it.
 func t3Base(home string) string { return appdir.T3Code(home) }
@@ -164,6 +172,9 @@ func t3code(home string) *Agent {
 			if why := wiringOff("T3 Code", path, func(k string) (string, bool) { return t3EnvOf(path, k) }, "ANTHROPIC_BASE_URL", gateway.URL()); why != "" {
 				return why
 			}
+			if tok, _ := t3EnvOf(path, "ANTHROPIC_AUTH_TOKEN"); t3KeepSignIn(gateway.URL()) && tok != "" {
+				return "T3 Code's ANTHROPIC_AUTH_TOKEN (" + filepath.Base(path) + ") is set, so Claude Code sends magpie that key, not its claude.ai sign-in as magpie set it"
+			}
 			at := here(home)
 			return claudeCloud(at, filepath.Join(at.claudeDir(), "settings.json"))
 		},
@@ -192,6 +203,37 @@ func t3code(home string) *Agent {
 			Options: func(map[string]string) []Option {
 				return []Option{{Value: magpieID, Label: "magpie", Icon: "magpie", Note: "every magpie model in T3 Code twice: magpie on Claude Code, magpie · Codex on Codex; pick one in T3's model picker"}}
 			},
+		}, {
+			Key: "login", Label: "sign-in", Quiet: true,
+			Get: func() string {
+				if claudeOn() && t3KeepSignIn(gateway.URL()) {
+					return "claudeai"
+				}
+				return ""
+			},
+			Set: func(v string) error {
+				if v != "" && v != "claudeai" {
+					return fmt.Errorf("sign-in is claudeai or empty (magpie's key), not %q", v)
+				}
+				if !claudeOn() {
+					if v == "" {
+						stash(map[string]string{t3Login: ""})
+						return nil
+					}
+					return fmt.Errorf("connect T3 Code to magpie first; it can then keep its claude.ai sign-in")
+				}
+				if v != "" && keyAt(gateway.URL()) != gateway.Token && t3StashedValue(t3Login) != v {
+					return fmt.Errorf("T3 Code reaches magpie at %s with a sharing key, so it can't keep its claude.ai sign-in there", gateway.URL())
+				}
+				stash(map[string]string{t3Login: v})
+				return edit.SetJSON(path, edit.KV{Path: t3Instance, Value: t3Merged(path, gateway.URL())})
+			},
+			Options: func(map[string]string) []Option {
+				if !claudeOn() || keyAt(gateway.URL()) != gateway.Token {
+					return nil
+				}
+				return claudeSignIns()
+			},
 		}},
 	}
 }
@@ -239,9 +281,13 @@ func t3InstanceJSON(path, gw string) map[string]any {
 			config[k] = v
 		}
 	}
+	token := keyAt(gw)
+	if t3KeepSignIn(gw) {
+		token = ""
+	}
 	environment := []map[string]any{
 		{"name": "ANTHROPIC_BASE_URL", "value": gw, "sensitive": false},
-		{"name": "ANTHROPIC_AUTH_TOKEN", "value": keyAt(gw), "sensitive": false},
+		{"name": "ANTHROPIC_AUTH_TOKEN", "value": token, "sensitive": false},
 	}
 	// auto mode's review off unless every model it lists is one whose
 	// review comes back, as for Claude Code itself (claudeReviewEnv); a value in the
@@ -549,11 +595,22 @@ func t3CodexBaseOf(args string) string {
 	return base
 }
 
-// t3Stashed reports whether the stash holds key.
-func t3Stashed(key string) bool {
+// t3StashedValue returns the stashed value for key.
+func t3StashedValue(key string) string {
 	stashMu.Lock()
 	defer stashMu.Unlock()
-	return stashShared()[key] != ""
+	return stashShared()[key]
+}
+
+// t3Stashed reports whether the stash holds key.
+func t3Stashed(key string) bool {
+	return t3StashedValue(key) != ""
+}
+
+// t3KeepSignIn reports whether T3 Code's magpie Claude Code instance should
+// leave ANTHROPIC_AUTH_TOKEN empty so Claude Code keeps its claude.ai sign-in.
+func t3KeepSignIn(gw string) bool {
+	return keyAt(gw) == gateway.Token && t3StashedValue(t3Login) == "claudeai"
 }
 
 // t3Tokens is T3 Code's tokenizeCliArgs (packages/shared/src/cliArgs.ts),
diff --git a/internal/agent/t3code_test.go b/internal/agent/t3code_test.go
index 8b1a1d711..790ce5721 100644
--- a/internal/agent/t3code_test.go
+++ b/internal/agent/t3code_test.go
@@ -7,6 +7,7 @@ import (
 	"path/filepath"
 	"regexp"
 	"slices"
+	"strings"
 	"testing"
 
 	"github.com/yetone/magpie/internal/edit"
@@ -433,3 +434,110 @@ func TestT3CodeKeepsTheUsersSettings(t *testing.T) {
 		t.Errorf("custom models not magpie's: %+v", got.Config.CustomModels)
 	}
 }
+
+// T3 Code's magpie Claude Code instance can keep Claude Code's claude.ai
+// sign-in (login=claudeai): ANTHROPIC_AUTH_TOKEN is left empty so Claude Code
+// stays signed in to claude.ai and reads anthropic-ratelimit-unified-* headers
+// (for status lines and T3 Code usage-limit auto-resume). Sync, reconnect and
+// Check all preserve it, and setting login back to "" restores magpie's key.
+func TestT3CodeKeepsItsClaudeAISignIn(t *testing.T) {
+	home := syncHome(t)
+	t.Setenv("T3CODE_HOME", "")
+	t.Setenv("MAGPIE_ADDR", "")
+	path := filepath.Join(home, ".t3", "userdata", "settings.json")
+	os.MkdirAll(filepath.Dir(path), 0o755)
+	os.WriteFile(path, []byte(t3User), 0o600)
+
+	a := t3code(home)
+	login := a.Field("login")
+	if login == nil {
+		t.Fatal("T3 Code has no sign-in field")
+	}
+	if opts := login.Options(a.Values()); len(opts) != 0 {
+		t.Fatalf("sign-in options offered before T3 Code is connected: %v", opts)
+	}
+	if err := login.Set("claudeai"); err == nil {
+		t.Fatal("sign-in set to claudeai before T3 Code is connected")
+	}
+	if err := a.Apply("provider", magpieID); err != nil {
+		t.Fatal(err)
+	}
+	if tok, ok := t3EnvOf(path, "ANTHROPIC_AUTH_TOKEN"); !ok || tok != gateway.Token {
+		t.Fatalf("magpie's key by default: %q (%v)", tok, ok)
+	}
+	if opts := login.Options(a.Values()); len(opts) != 2 {
+		t.Fatalf("sign-in options: %v", opts)
+	}
+	if err := login.Set("bogus"); err == nil {
+		t.Fatal("unknown sign-in accepted")
+	}
+	if err := a.Apply("login", "claudeai"); err != nil {
+		t.Fatal(err)
+	}
+	kept := func(when string) {
+		t.Helper()
+		raw, ok := edit.GetJSON(path, t3Instance)
+		if !ok {
+			t.Fatalf("%s: magpie instance missing", when)
+		}
+		t3Format(t, []byte(raw))
+		if tok, has := t3EnvOf(path, "ANTHROPIC_AUTH_TOKEN"); !has || tok != "" {
+			t.Fatalf("%s: ANTHROPIC_AUTH_TOKEN %q (has %v), want empty", when, tok, has)
+		}
+		if u, _ := t3EnvOf(path, "ANTHROPIC_BASE_URL"); u != gateway.URL() {
+			t.Fatalf("%s: ANTHROPIC_BASE_URL %q", when, u)
+		}
+		if got := a.Values()["login"]; got != "claudeai" {
+			t.Fatalf("%s: login %q, want claudeai", when, got)
+		}
+		if why := a.Check(); why != "" {
+			t.Fatalf("%s: unexpected check drift %q", when, why)
+		}
+	}
+	kept("set")
+
+	if err := a.Sync(); err != nil {
+		t.Fatal(err)
+	}
+	kept("after sync")
+
+	// a non-empty key put back by hand is caught by Check and repaired by Sync
+	var inst map[string]any
+	raw, _ := edit.GetJSON(path, t3Instance)
+	json.Unmarshal([]byte(raw), &inst)
+	for _, v := range inst["environment"].([]any) {
+		if m := v.(map[string]any); m["name"] == "ANTHROPIC_AUTH_TOKEN" {
+			m["value"] = "sk-hand"
+		}
+	}
+	if err := edit.SetJSON(path, edit.KV{Path: t3Instance, Value: inst}); err != nil {
+		t.Fatal(err)
+	}
+	if why := a.Check(); !strings.Contains(why, "sends magpie that key, not its claude.ai sign-in") {
+		t.Fatalf("hand-set key not caught: %q", why)
+	}
+	if err := a.Sync(); err != nil {
+		t.Fatal(err)
+	}
+	kept("repaired by sync")
+
+	// turning T3 Code off and back on keeps claude.ai sign-in
+	if err := a.Apply("provider", ""); err != nil {
+		t.Fatal(err)
+	}
+	if got := a.Values()["login"]; got != "" {
+		t.Fatalf("login %q when disconnected", got)
+	}
+	if err := a.Apply("provider", magpieID); err != nil {
+		t.Fatal(err)
+	}
+	kept("reconnected")
+
+	// switching back to magpie's key restores gateway.Token
+	if err := a.Apply("login", ""); err != nil {
+		t.Fatal(err)
+	}
+	if tok, ok := t3EnvOf(path, "ANTHROPIC_AUTH_TOKEN"); !ok || tok != gateway.Token || a.Values()["login"] != "" || a.Check() != "" {
+		t.Fatalf("back to magpie's key: tok=%q (%v) login=%q check=%q", tok, ok, a.Values()["login"], a.Check())
+	}
+}
diff --git a/internal/gui/t3code_state_test.go b/internal/gui/t3code_state_test.go
index deb164995..791e36a84 100644
--- a/internal/gui/t3code_state_test.go
+++ b/internal/gui/t3code_state_test.go
@@ -29,8 +29,8 @@ func TestStateListsT3Code(t *testing.T) {
 	if a == nil {
 		t.Fatal("T3 Code not listed")
 	}
-	if a.Name != "T3 Code" || a.Icon != "t3code" || a.Path != filepath.Join("~", ".t3", "userdata", "settings.json") || len(a.Fields) != 1 || a.Fields[0].Key != "provider" ||
-		len(a.Fields[0].Options) != 1 || a.Fields[0].Options[0].Value != "magpie" {
+	if a.Name != "T3 Code" || a.Icon != "t3code" || a.Path != filepath.Join("~", ".t3", "userdata", "settings.json") || len(a.Fields) != 2 || a.Fields[0].Key != "provider" ||
+		len(a.Fields[0].Options) != 1 || a.Fields[0].Options[0].Value != "magpie" || a.Fields[1].Key != "login" || len(a.Fields[1].Options) != 0 {
 		t.Fatalf("T3 Code: %+v", a)
 	}
 }
-- 
2.50.1 (Apple Git-155)

```

Attribution: the fix is @Yukaii's (Yukai Huang, author kept on both commits); AI-written (GLM-5.3-Flash (ZCode)) carried it onto the current main and ran the verification below.
