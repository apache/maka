Refresh of my carry above, not a redesign: @Kymorphius's same commit carried onto current `upstream/main` (`0d0a1a567`) and the verification re-run — the branch had drifted ~900 commits since November 7. The carry needed two adaptations, both mechanical, none touching the patch's own semantics; every hunk of the reporter's production code is otherwise byte-identical to their commit:

1. `affine`-style signature drift did not occur here, but main's newer fixture `copilot_pool_models_test.go` (`TestCopilotAccountsWithOtherModels`) records every non-`/models` request the fake CAPI receives as a chat try. The carried feature legitimately asks `/meta` once per list fetch (`copilotHasFusion`), so that fixture now answers `/meta` with an empty tier list and records nothing — the test's own assertions are unchanged, and the probe is not a chat. Without it the test fails with the probe recorded as `octocat:,hubot:` before the real try.
2. Nothing else: `gateway.go`'s two `CopilotRoutes` call sites, `usage/served.go`'s one, `copilot_auto.go`, `copilot_refused.go`, `account.go`, the fusion module and its tests all cherry-picked clean.

<details><summary>patch: 1107｜功能｜接入 Copilot Fusion Standard 协议 (expose copilot/fusion as Copilot Fusion Standard, #5599, Kymorphius) — git am applies it as is; SHA-256 first 16: 3a4cfc47db35f29c</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: Ki <224157893+Kymorphius@users.noreply.github.com>
Date: Fri, 6 Nov 2026 23:27:35 -0800
Subject: [PATCH] =?UTF-8?q?1107=EF=BD=9C=E5=8A=9F=E8=83=BD=EF=BD=9C?=
 =?UTF-8?q?=E6=8E=A5=E5=85=A5=20Copilot=20Fusion=20Standard=20=E5=8D=8F?=
 =?UTF-8?q?=E8=AE=AE?=
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

provider/gateway: expose copilot/fusion as Copilot Fusion Standard when CAPI /meta advertises an enabled, visible balance/standard tier.

Match the observed Copilot CLI 1.0.107 wire request: POST /auto with tier=balance and fusion=true; forward the selected model with its Copilot-Session-Token at API version 2026-08-01. Keep Fusion sessions and refusal records separate from legacy Auto, and do not substitute legacy routing inside Fusion resolution. Update served-model classification and the provider subsystem reference. High/Max orchestration is intentionally outside this change.

Validation on upstream base 325dc3ab32337e2cd062b1b357a365d0cb1645bd:
- go test -race -tags nogui ./internal/provider ./internal/gateway ./internal/usage -run TestCopilot|TestSwapped -count=3 -timeout 10m: all three packages pass.
- go vet -tags nogui ./internal/provider ./internal/gateway ./internal/usage: pass.
- gofmt and git diff --check: clean.
- Red on base via a Go overlay of the original production files: TestCopilotFusionStandard fails with Fusion Standard missing from models; green with the patch.

Earlier validation on v0.1.3190: native/Linux/Windows vet and builds, desktop build, isolated real Chat/Responses/Anthropic and streaming requests passed. A same-model billing comparison returned 70% of ordinary input/cache-read/cache-write/output rates. The full Go run passed every package except the old WSL fixture from #5570; after applying its existing upstream fix separately, the agent package also passed in full. That fixture fix is already on this branch base and is not part of this patch. The full suite was not rerun on the rebased upstream base.
---
 docs/subsystems/providers-accounts.md         |  24 +++
 internal/gateway/copilot_auto_test.go         |   2 +
 internal/gateway/copilot_fusion_test.go       |  72 +++++++
 internal/gateway/copilot_pool_models_test.go  |   7 +
 internal/gateway/copilot_refused_test.go      |   2 +
 internal/gateway/copilot_repick_test.go       |   8 +-
 internal/gateway/gateway.go                   |   4 +-
 internal/gateway/served_test.go               |   1 +
 internal/provider/account.go                  |   6 +
 internal/provider/copilot_api_version_test.go |   3 +
 internal/provider/copilot_auto.go             |  55 ++++-
 internal/provider/copilot_auto_test.go        |   2 +
 internal/provider/copilot_fusion.go           |  52 +++++
 internal/provider/copilot_fusion_test.go      | 194 ++++++++++++++++++
 internal/provider/copilot_refused.go          |  23 ++-
 internal/provider/copilot_refused_test.go     |   2 +
 internal/usage/served.go                      |   2 +-
 17 files changed, 435 insertions(+), 24 deletions(-)
 create mode 100644 internal/gateway/copilot_fusion_test.go
 create mode 100644 internal/provider/copilot_fusion.go
 create mode 100644 internal/provider/copilot_fusion_test.go

diff --git a/docs/subsystems/providers-accounts.md b/docs/subsystems/providers-accounts.md
index f1924769f..fafc21476 100644
--- a/docs/subsystems/providers-accounts.md
+++ b/docs/subsystems/providers-accounts.md
@@ -198,6 +198,30 @@ Account discovery can be turned off (#1535): Settings → Privacy → *Subscript
 
 A signed-in account's model list exists only at its vendor (the ChatGPT backend's `/models` for a Codex sign-in, …), so `FetchNew` asks for the lists not fetched yet. Every front end calls it at start: the window (`startBackend`, then `FetchNewSoon` behind `/api/state`), the TUI (`fetchModelsCmd` in `Init`) and `magpie serve` (#1789, reyoung: the terminal and a headless gateway had offered the built-in Cursor's fallback `auto` alone until the list was fetched by hand). Listing the accounts asks a CLI who is signed in, and a look waits `firstAsk` (3s) for that; `cursor-agent about` asks Cursor's servers and can take longer, so `FetchNew` waits for each CLI asked for the first time (`awaitIdentities` in [`cli_identity.go`](../../internal/provider/cli_identity.go)) and lists the accounts again. It reports whether an account was left without its list (failed, or waiting `newFetchRetry` after a failure): the TUI then asks again a minute later (`modelsRetry`) and `serve` loops the same way, while the window asks again from its pages. A TUI model picker open when the list arrives is filled in place (`relist`), keeping its filter and the model under the cursor. `TestFetchNewAccount` and the TUI's `TestTUIFetchesSubscriptionModels` / `TestTUIAsksAgainForAMissingList` cover it. A list fetched once is not left as it was: the magpie serving the gateway looks every hour ([`KeepAccountsListed`](../../internal/provider/account_relist.go), first two minutes after it starts) and fetches again each signed-in built-in account's list that is 45 minutes old (`accountListAge`, `relistAccounts`), so a model the vendor adds to the plan is served without Refresh or a magpie release (cliff_26651 on Discord: GPT-6.1 Terra, served to ChatGPT accounts from 10-26, missing from Codex through a magpie whose Codex list was fetched on 10-12). A plugin's accounts are `KeepPluginsListed`'s, one switched off isn't asked, and a fetch that fails keeps the list there was. `TestAccountListFollowsTheVendor` and `TestKeepAccountsListedAsks` cover it. The saved ChatGPT accounts behind the one Codex is signed in to are listed with that fetch (`codexFetchSaved`), but not each time: one with no list yet is asked at once, the others once a day (`codexSavedListAge`) and one a look (`codexSavedAtOnce`), the one asked longest ago first, and one that failed waits its day too (`codexSavedAsked`). Asking every switched-on saved account each hour was a burst of `/codex/models` calls from one address for accounts no Codex used (`TestSavedCodexListsOnceADay`). Each list is kept with the Codex version it was asked for (`catalog.SaveLiveAsked`), as the backend lists a model only to a client new enough for it; a saved account's list asked for an older Codex than magpie speaks as now, or kept with no version, is asked at the next look as one with no list, an hour after a failed try (`codexListBehind`, `codexBehindRetry`, `TestBehindListAskedAgain`); so is one fetched more than `listRound` (10 minutes) before another account's list first had a model (`catalog.LiveNewest`, `TestListOlderThanAnothersModelAskedAgain`). An account's own list (Codex's, Antigravity's) is evidence its plan lacks a model only when it can know the model: `AccountsFor` routes over, as unknown, an account whose list was fetched more than `listRound` before another account's list first had the model (lists fetched in one look are the plans' difference; `catalog.LiveSince`, each model's first save kept from save to save) or, for ChatGPT, was asked for an older Codex (`Account.listLags`; wudao_85256 on Discord: the second of two Plus accounts was "its plan doesn't list gpt-6.1-sol" and never failed over to; `TestStaleAccountListIsNotAPlanWithoutTheModel`). Every call magpie makes about a ChatGPT account, not only `/codex/models` and `/responses` (`codexSign`), carries Codex's `originator` and User-Agent (`codexClientHeaders`, codex-rs `default_headers`): `/wham/usage`, the reset credits and their use (`codexAccountHeaders`), and the token endpoint's refresh and sign-in exchange. The refresh's body is codex-rs's: `client_id`, `grant_type`, `refresh_token` and a `refresh_reason` (`proactive_expiry`, `scheduled` from the keep-alive, `unauthorized_recovery` after a 401, `forced`), with no `scope` (`TestCodexAccountCallsGoAsCodex`, `TestCodexRefreshSaysWhy`).
 
+## Copilot Fusion Standard
+
+Copilot's model list includes `copilot/fusion` (Copilot Fusion Standard)
+when `/meta`, at API version `2026-09-21`, advertises an enabled, visible
+`balance` tier with `tier_level: "standard"`. Failed or older metadata
+leaves it out without removing legacy Auto or the account's other models
+([`copilot_fusion.go`](../../internal/provider/copilot_fusion.go)).
+
+The gateway resolves this selection through `/auto` at `2026-08-01`, with
+the user's prompt, `tier: "balance"` and `fusion: true`, as Copilot CLI
+1.0.107 does. Inference names the selected model on its advertised API and
+carries `Copilot-Session-Token` at the same API version. Its sessions and
+model refusals are separate from legacy `copilot/auto`, which sends no Fusion flag. A
+refused or unavailable Fusion selection fails explicitly; it never falls
+back to legacy Auto or an ordinary model without Fusion billing context
+([`copilot_auto.go`](../../internal/provider/copilot_auto.go)).
+
+GitHub controls the promotion and billing; no permanent discount is saved
+as a model price. Fusion High and Max require the official client's
+multi-model orchestration and are not exposed as direct model endpoints.
+`TestCopilotFusionStandard` checks the catalog, billing flag, isolated
+sessions and failure behavior; `TestCopilotFusionThroughGateway` checks
+Chat, Responses and Anthropic clients.
+
 ## Runtime path
 
 1. **Add.** The Providers page adds a key provider through `Add` or `Save`, or an account through `StartSignIn`. An agent signed in on its own is found by `Accounts` with no step from the user.
diff --git a/internal/gateway/copilot_auto_test.go b/internal/gateway/copilot_auto_test.go
index 08e69a9f7..b86532060 100644
--- a/internal/gateway/copilot_auto_test.go
+++ b/internal/gateway/copilot_auto_test.go
@@ -36,6 +36,8 @@ func TestCopilotAutoThroughGateway(t *testing.T) {
 		mu.Lock()
 		defer mu.Unlock()
 		switch r.URL.Path {
+		case "/meta":
+			w.WriteHeader(404) // legacy catalog
 		case "/models":
 			io.WriteString(w, `{"data":[
 			  {"id":"gpt-5-mini","name":"GPT-5 mini","model_picker_enabled":true,"policy":{"state":"disabled"},"supported_endpoints":["/responses"],"capabilities":{"type":"chat"}}]}`)
diff --git a/internal/gateway/copilot_fusion_test.go b/internal/gateway/copilot_fusion_test.go
new file mode 100644
index 000000000..ebf94fe2e
--- /dev/null
+++ b/internal/gateway/copilot_fusion_test.go
@@ -0,0 +1,72 @@
+package gateway
+
+import (
+	"encoding/json"
+	"io"
+	"net/http"
+	"strings"
+	"sync"
+	"testing"
+)
+
+func TestCopilotFusionThroughGateway(t *testing.T) {
+	var mu sync.Mutex
+	var prompts, sent []string
+	copilotFake(t, "gho_fusion_gateway", func(w http.ResponseWriter, r *http.Request) {
+		mu.Lock()
+		defer mu.Unlock()
+		switch r.URL.Path {
+		case "/models":
+			io.WriteString(w, copilotStudentModels)
+		case "/auto":
+			var q struct {
+				Fusion bool   `json:"fusion"`
+				Tier   string `json:"tier"`
+				Prompt string `json:"prompt"`
+			}
+			json.NewDecoder(r.Body).Decode(&q)
+			if !q.Fusion || q.Tier != "balance" {
+				t.Errorf("Fusion not requested: %+v", q)
+			}
+			prompts = append(prompts, q.Prompt)
+			io.WriteString(w, `{"session_token":"fusion-session","selected_model":{"id":"gpt-4.1","supported_endpoints":["/chat/completions"]},"expires_at":0}`)
+		case "/chat/completions":
+			b, _ := io.ReadAll(r.Body)
+			sent = append(sent, modelOf(b)+" "+r.Header.Get("Copilot-Session-Token")+" "+r.Header.Get("X-GitHub-Api-Version"))
+			if strings.Contains(string(b), `"stream":true`) {
+				w.Header().Set("Content-Type", "text/event-stream")
+				io.WriteString(w, "data: {\"id\":\"c1\",\"model\":\"gpt-4.1\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"hello from fusion\"}}]}\n\n")
+				io.WriteString(w, "data: {\"id\":\"c1\",\"model\":\"gpt-4.1\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":3}}\n\ndata: [DONE]\n\n")
+				return
+			}
+			io.WriteString(w, `{"id":"c1","model":"gpt-4.1","choices":[{"index":0,"message":{"role":"assistant","content":"hello from fusion"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":3}}`)
+		default:
+			t.Errorf("unexpected fallback to %s", r.URL.Path)
+			w.WriteHeader(500)
+		}
+	})
+	s := New()
+	for _, tc := range []struct{ path, body string }{
+		{"/v1/chat/completions", `{"model":"copilot/fusion","messages":[{"role":"user","content":"Use Fusion"}]}`},
+		{"/v1/responses", `{"model":"copilot/fusion","input":"Use Fusion"}`},
+		{"/v1/messages", `{"model":"copilot/fusion","max_tokens":100,"messages":[{"role":"user","content":"Use Fusion"}]}`},
+	} {
+		code, body := postTo(t, s, tc.path, tc.body)
+		if code != 200 || !strings.Contains(body, "hello from fusion") {
+			t.Fatalf("%s: %d %s", tc.path, code, body)
+		}
+	}
+	mu.Lock()
+	defer mu.Unlock()
+	if len(prompts) != 1 || prompts[0] != "Use Fusion" || len(sent) != 3 {
+		t.Fatalf("prompts: %q, sent: %q", prompts, sent)
+	}
+	for _, request := range sent {
+		if request != "gpt-4.1 fusion-session 2026-08-01" {
+			t.Errorf("inference lost its Fusion session: %s", request)
+		}
+	}
+	if call := s.Recent()[0]; call.Usage.Served != "gpt-4.1" {
+		t.Errorf("served model lost: %+v", call)
+	}
+}
diff --git a/internal/gateway/copilot_pool_models_test.go b/internal/gateway/copilot_pool_models_test.go
index 6724d2928..190b8a935 100644
--- a/internal/gateway/copilot_pool_models_test.go
+++ b/internal/gateway/copilot_pool_models_test.go
@@ -71,6 +71,13 @@ func copilotTwoPlansListing(t *testing.T, extra []string) (tried func() string)
 			json.NewEncoder(w).Encode(map[string]any{"data": data})
 			return
 		}
+		if r.URL.Path == "/meta" {
+			// the Fusion Standard capability probe (copilotHasFusion,
+			// #5599) asks this once per list fetch; this plan serves no
+			// Fusion tier, and the probe is not a chat try
+			json.NewEncoder(w).Encode(map[string]any{"auto": map[string]any{"tiers": []any{}}})
+			return
+		}
 		var q struct {
 			Model string `json:"model"`
 		}
diff --git a/internal/gateway/copilot_refused_test.go b/internal/gateway/copilot_refused_test.go
index ebb363d09..c1f84ed08 100644
--- a/internal/gateway/copilot_refused_test.go
+++ b/internal/gateway/copilot_refused_test.go
@@ -35,6 +35,8 @@ func TestCopilotAutoRefusedThroughGateway(t *testing.T) {
 		mu.Lock()
 		defer mu.Unlock()
 		switch r.URL.Path {
+		case "/meta":
+			w.WriteHeader(404) // legacy catalog
 		case "/models":
 			io.WriteString(w, `{"data":[
 			  {"id":"claude-haiku-4.5","name":"Claude Haiku 4.5","model_picker_enabled":true,"policy":{"state":"enabled"},"supported_endpoints":["/chat/completions","/v1/messages"],"capabilities":{"type":"chat"}},
diff --git a/internal/gateway/copilot_repick_test.go b/internal/gateway/copilot_repick_test.go
index a9cadf5bb..e49c44e5c 100644
--- a/internal/gateway/copilot_repick_test.go
+++ b/internal/gateway/copilot_repick_test.go
@@ -25,7 +25,13 @@ func copilotFake(t *testing.T, gh string, api http.HandlerFunc) {
 	os.WriteFile(filepath.Join(cfg, "github-copilot", "apps.json"), mustJSON(map[string]any{
 		"github.com:Iv1.x": map[string]any{"user": "student", "oauth_token": gh},
 	}), 0o600)
-	up := httptest.NewServer(api)
+	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		if r.URL.Path == "/meta" {
+			w.WriteHeader(404) // legacy Auto fixture
+			return
+		}
+		api(w, r)
+	}))
 	t.Cleanup(up.Close)
 	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
 		if strings.HasSuffix(r.URL.Path, "/token") {
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index 607f8c2b6..b8ec0dd4b 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -5618,7 +5618,7 @@ func (s *Server) attempt(w http.ResponseWriter, r *http.Request, from provider.P
 	// Copilot's Auto (all a Student plan may pick) is asked which model it
 	// picks, as Copilot's clients do, and the request goes to that model on
 	// the APIs it is served on, with the session's token
-	if model == provider.CopilotAuto && p.Account != nil && p.Account.Agent == "copilot" {
+	if provider.CopilotRoutes(model) && p.Account != nil && p.Account.Agent == "copilot" {
 		r = r.WithContext(provider.WithAutoPrompt(r.Context(), lastUserText(from, body)))
 	}
 	if ctx, m, err := p.ResolveAuto(r.Context(), model); err != nil {
@@ -5793,7 +5793,7 @@ func firstElsewhere(p provider.Provider, model string, from provider.Protocol) b
 
 // autoPicks is whether c is Copilot's Auto, which picks the model itself.
 func autoPicks(c candidate) bool {
-	return c.model == provider.CopilotAuto && c.p.Account != nil && c.p.Account.Agent == "copilot"
+	return provider.CopilotRoutes(c.model) && c.p.Account != nil && c.p.Account.Agent == "copilot"
 }
 
 // lastUserText is what the user said last (userSaid), which Copilot's Auto
diff --git a/internal/gateway/served_test.go b/internal/gateway/served_test.go
index d88597520..89eb382d3 100644
--- a/internal/gateway/served_test.go
+++ b/internal/gateway/served_test.go
@@ -203,6 +203,7 @@ func TestSwappedModel(t *testing.T) {
 		{"us.anthropic.claude-sonnet-4-20250514-v1:0", "claude-sonnet-4-20250514", false},
 		{"auto", "gpt-5-mini", false}, // Copilot's Auto, Cursor's: the vendor was asked to pick
 		{"copilot/auto", "claude-sonnet-5", false},
+		{"copilot/fusion", "gpt-6-luna", false},
 		// a remote magpie's routing group, answered by the member it routed to
 		{"group/auto-deepseek-v4-1-flash", "deepseek/deepseek-v4.1-flash", false},
 		{"group/fast", "luna", false},
diff --git a/internal/provider/account.go b/internal/provider/account.go
index 91298d632..7f48b7f89 100644
--- a/internal/provider/account.go
+++ b/internal/provider/account.go
@@ -1560,6 +1560,9 @@ func copilotProvider(app copilotApp, plan string) Provider {
 		for k, v := range s.headers() {
 			req.Header.Set(k, v)
 		}
+		if copilotFusion(ctx) || bodyModel(body) == CopilotFusion {
+			req.Header.Set("X-GitHub-Api-Version", copilotAutoV2Version)
+		}
 		req.Header.Set("Openai-Intent", "conversation-panel")
 		// a turn the user typed is billed as one; a tool's reply is not
 		req.Header.Set("X-Initiator", "agent")
@@ -1890,6 +1893,9 @@ func copilotModels(ctx context.Context, app copilotApp) ([]catalog.Model, error)
 	// it lists, and the only choice a Student plan has: an account whose
 	// list leaves it nothing to pick by hand still has it
 	out = append(out, copilotAutoModel)
+	if copilotHasFusion(ctx, app, s) {
+		out = append(out, catalog.Model{ID: CopilotFusion, Name: "Copilot Fusion Standard"})
+	}
 	slices.SortStableFunc(picks, func(a, b string) int { return rank[a] - rank[b] })
 	copilotTermsMu.Lock()
 	copilotTerms[app.Token] = waiting
diff --git a/internal/provider/copilot_api_version_test.go b/internal/provider/copilot_api_version_test.go
index c604b17fa..086e3e560 100644
--- a/internal/provider/copilot_api_version_test.go
+++ b/internal/provider/copilot_api_version_test.go
@@ -31,6 +31,9 @@ func (c *studentAuto) ServeHTTP(w http.ResponseWriter, r *http.Request) {
 	c.mu.Lock()
 	defer c.mu.Unlock()
 	switch r.URL.Path {
+	case "/meta":
+		w.WriteHeader(404)
+		return
 	case "/models":
 		io.WriteString(w, `{"data":[
 		  {"id":"gpt-4.1","name":"GPT-4.1","model_picker_enabled":true,"policy":{"state":"enabled"},"supported_endpoints":["/chat/completions"],"capabilities":{"type":"chat"}},
diff --git a/internal/provider/copilot_auto.go b/internal/provider/copilot_auto.go
index f33cc960d..095a7da13 100644
--- a/internal/provider/copilot_auto.go
+++ b/internal/provider/copilot_auto.go
@@ -51,6 +51,12 @@ import (
 // CopilotAuto is the model id that has Copilot pick the model.
 const CopilotAuto = "auto"
 
+// CopilotFusion selects Fusion Standard, the single-model Fusion tier.
+const CopilotFusion = "fusion"
+
+// CopilotRoutes reports whether Copilot selects the upstream model.
+func CopilotRoutes(model string) bool { return model == CopilotAuto || model == CopilotFusion }
+
 // copilotAutoVersion is the API version VS Code's Copilot Chat asks for an
 // Auto session with; the Copilot CLI's headers name their own.
 const copilotAutoVersion = "2025-10-01"
@@ -68,6 +74,7 @@ const copilotAutoReuse = time.Hour
 var copilotAutoModel = catalog.Model{ID: CopilotAuto, Name: "Auto"}
 
 type copilotAutoSession struct {
+	Fusion    bool // a Fusion session must never be reused by legacy Auto
 	Token     string
 	Model     string // the model Copilot picked
 	ExpiresAt int64
@@ -164,6 +171,20 @@ type copilotAutoKey struct{}
 
 type copilotAutoPromptKey struct{}
 
+type copilotFusionKey struct{}
+
+func copilotFusion(ctx context.Context) bool {
+	fusion, _ := ctx.Value(copilotFusionKey{}).(bool)
+	return fusion
+}
+
+func copilotAutoCacheKey(token string, fusion bool) string {
+	if fusion {
+		return token + "\x00fusion"
+	}
+	return token
+}
+
 // WithAutoPrompt carries the prompt of the request Copilot's Auto picks a
 // model for: POST /auto picks for a prompt.
 func WithAutoPrompt(ctx context.Context, prompt string) context.Context {
@@ -176,7 +197,8 @@ func WithAutoPrompt(ctx context.Context, prompt string) context.Context {
 func copilotAutoResolve(ctx context.Context, app copilotApp, fresh bool) (copilotAutoSession, error) {
 	copilotAutoMu.Lock()
 	defer copilotAutoMu.Unlock()
-	if a, ok := copilotAutoSessions[app.Token]; ok && !fresh && (a.ExpiresAt == 0 || time.Until(time.Unix(a.ExpiresAt, 0)) > 2*time.Minute) && !copilotRefuses(app.Token, a.Model) {
+	key := copilotAutoCacheKey(app.Token, copilotFusion(ctx))
+	if a, ok := copilotAutoSessions[key]; ok && !fresh && (a.ExpiresAt == 0 || time.Until(time.Unix(a.ExpiresAt, 0)) > 2*time.Minute) && !copilotRefuses(key, a.Model) {
 		return a, nil
 	}
 	s, err := app.session(ctx)
@@ -186,9 +208,14 @@ func copilotAutoResolve(ctx context.Context, app copilotApp, fresh bool) (copilo
 	base := s.apiBase(app.Host)
 	a, why, answered := copilotAutoRoute(ctx, app, s, base)
 	if why == "" {
-		copilotAutoSessions[app.Token] = a
+		copilotAutoSessions[key] = a
 		return a, nil
 	}
+	if copilotFusion(ctx) {
+		// Neither legacy Auto nor a manually picked model carries Fusion's
+		// billing context. An explicit Fusion request must fail instead.
+		return copilotAutoSession{}, errors.New("Copilot Fusion Standard: " + why)
+	}
 	if answered {
 		// /auto answered with a model the account was refused: Copilot
 		// Chat asks nothing else, and /models/session names the same few
@@ -274,7 +301,11 @@ func copilotAutoRoute(ctx context.Context, app copilotApp, s copilotSession, bas
 	if strings.TrimSpace(prompt) == "" {
 		prompt = "hi" // a model test, or a turn of tool results alone
 	}
-	body, _ := json.Marshal(map[string]string{"prompt": prompt, "tier": "balance"})
+	fields := map[string]any{"prompt": prompt, "tier": "balance"}
+	if copilotFusion(ctx) {
+		fields["fusion"] = true
+	}
+	body, _ := json.Marshal(fields)
 	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
 	defer cancel()
 	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/auto", bytes.NewReader(body))
@@ -306,7 +337,7 @@ func copilotAutoRoute(ctx context.Context, app copilotApp, s copilotSession, bas
 		return copilotAutoSession{}, APIError(b, res.Status), false
 	case json.Unmarshal(b, &v) != nil || v.Token == "" || v.Selected.ID == "":
 		return copilotAutoSession{}, "picked no model: " + clipLine(string(b)), false
-	case copilotRefuses(app.Token, v.Selected.ID):
+	case copilotRefuses(copilotAutoCacheKey(app.Token, copilotFusion(ctx)), v.Selected.ID):
 		return copilotAutoSession{}, "picked " + v.Selected.ID + ", which the account was refused", true
 	}
 	// the pick's endpoints, which the account's list may not give
@@ -319,7 +350,7 @@ func copilotAutoRoute(ctx context.Context, app copilotApp, s copilotSession, bas
 	if v.ExpiresAt > 0 && v.ExpiresAt < exp {
 		exp = v.ExpiresAt
 	}
-	return copilotAutoSession{Token: v.Token, Model: v.Selected.ID, ExpiresAt: exp, Via: "/auto"}, "", true
+	return copilotAutoSession{Token: v.Token, Model: v.Selected.ID, ExpiresAt: exp, Via: "/auto", Fusion: copilotFusion(ctx)}, "", true
 }
 
 // copilotAutoFallback stands in for an Auto session Copilot has none of for
@@ -349,9 +380,12 @@ func copilotAutoFallback(ctx context.Context, app copilotApp, why string) (copil
 // (Copilot's Auto) into one for the model it picked: ctx then carries what
 // the request is signed with. Any other model comes back as it was.
 func (p Provider) ResolveAuto(ctx context.Context, model string) (context.Context, string, error) {
-	if p.Account == nil || p.Account.auto == nil || model != CopilotAuto {
+	if p.Account == nil || p.Account.auto == nil || !CopilotRoutes(model) {
 		return ctx, model, nil
 	}
+	if model == CopilotFusion {
+		ctx = context.WithValue(ctx, copilotFusionKey{}, true)
+	}
 	a, err := p.Account.auto(p.Via(ctx))
 	if err != nil {
 		return ctx, model, err
@@ -383,9 +417,12 @@ func CopilotRefusal(body []byte) bool { return copilotNotServed.Match(body) }
 // swapped for the one picked.
 func copilotAutoSign(ctx context.Context, app copilotApp, req *http.Request, body []byte) (model string, err error) {
 	model = bodyModel(body)
+	if model == CopilotFusion {
+		ctx = context.WithValue(ctx, copilotFusionKey{}, true)
+	}
 	a, auto := ctx.Value(copilotAutoKey{}).(copilotAutoSession)
 	auto = auto && a.Model == model
-	if auto && !copilotRefuses(app.Token, model) && copilotAutoHeld(app.Token, &a) {
+	if auto && !copilotRefuses(copilotAutoCacheKey(app.Token, a.Fusion), model) && copilotAutoHeld(app.Token, &a) {
 		if a.Token != "" {
 			req.Header.Set("Copilot-Session-Token", a.Token)
 		}
@@ -394,7 +431,7 @@ func copilotAutoSign(ctx context.Context, app copilotApp, req *http.Request, bod
 	}
 	// Auto's pick sent again once the account was refused it
 	// (copilotRefused) goes as Auto's next pick
-	if model != CopilotAuto && !auto {
+	if !CopilotRoutes(model) && !auto {
 		return model, nil
 	}
 	a, err = copilotAutoResolve(ctx, app, false)
@@ -425,7 +462,7 @@ func copilotAutoHeld(token string, a *copilotAutoSession) bool {
 	}
 	copilotAutoMu.Lock()
 	defer copilotAutoMu.Unlock()
-	cur, ok := copilotAutoSessions[token]
+	cur, ok := copilotAutoSessions[copilotAutoCacheKey(token, a.Fusion)]
 	if ok && cur.Model == a.Model {
 		*a = cur
 	}
diff --git a/internal/provider/copilot_auto_test.go b/internal/provider/copilot_auto_test.go
index eba98470a..283158e3c 100644
--- a/internal/provider/copilot_auto_test.go
+++ b/internal/provider/copilot_auto_test.go
@@ -40,6 +40,8 @@ func (c *studentCopilot) ServeHTTP(w http.ResponseWriter, r *http.Request) {
 		  {"id":"claude-sonnet-5","name":"Claude Sonnet 5","model_picker_category":"versatile","policy":{"state":"disabled"},"supported_endpoints":["/chat/completions","/v1/messages"],"capabilities":{"type":"chat"}}]}`)
 	case r.URL.Path == "/auto":
 		w.WriteHeader(404) // Auto v2 not offered: /models/session
+	case r.URL.Path == "/meta":
+		w.WriteHeader(404) // the older catalog has no Fusion metadata
 	case r.URL.Path == "/models/session" && r.Method == "POST":
 		c.sessions++
 		c.hints = string(b)
diff --git a/internal/provider/copilot_fusion.go b/internal/provider/copilot_fusion.go
new file mode 100644
index 000000000..f702ab529
--- /dev/null
+++ b/internal/provider/copilot_fusion.go
@@ -0,0 +1,52 @@
+package provider
+
+import (
+	"context"
+	"encoding/json"
+	"io"
+	"net/http"
+	"time"
+)
+
+// copilotHasFusion asks the same metadata API as Copilot CLI 1.0.107.
+// Standard is an "auto" tier with tier_level "standard", not "fusion".
+// High and Max need the client's orchestration runtime and aren't listed.
+func copilotHasFusion(ctx context.Context, app copilotApp, s copilotSession) bool {
+	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
+	defer cancel()
+	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.apiBase(app.Host)+"/meta", nil)
+	if err != nil {
+		return false
+	}
+	for k, v := range s.headers() {
+		req.Header.Set(k, v)
+	}
+	req.Header.Set("Authorization", "Bearer "+s.Token)
+	req.Header.Set("X-GitHub-Api-Version", "2026-09-21")
+	res, err := Keyed(http.DefaultClient).Do(req)
+	if err != nil {
+		return false
+	}
+	defer res.Body.Close()
+	var meta struct {
+		Auto struct {
+			Tiers []struct {
+				ID     string `json:"id"`
+				Level  string `json:"tier_level"`
+				Status struct {
+					Enabled bool  `json:"enabled"`
+					Picker  *bool `json:"tier_picker_enabled"`
+				} `json:"status"`
+			} `json:"tiers"`
+		} `json:"auto"`
+	}
+	if res.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&meta) != nil {
+		return false
+	}
+	for _, tier := range meta.Auto.Tiers {
+		if tier.ID == "balance" && tier.Level == "standard" && tier.Status.Enabled && (tier.Status.Picker == nil || *tier.Status.Picker) {
+			return true
+		}
+	}
+	return false
+}
diff --git a/internal/provider/copilot_fusion_test.go b/internal/provider/copilot_fusion_test.go
new file mode 100644
index 000000000..a92ae17fd
--- /dev/null
+++ b/internal/provider/copilot_fusion_test.go
@@ -0,0 +1,194 @@
+package provider
+
+import (
+	"context"
+	"encoding/json"
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"slices"
+	"strings"
+	"sync"
+	"testing"
+	"time"
+
+	"github.com/yetone/magpie/internal/catalog"
+)
+
+// The /meta tier fields captured from Copilot CLI 1.0.107, 2026-11-07.
+const fusionMeta = `{"auto":{"default_tier":"balance","tiers":[
+ {"id":"balance","display_name":"Standard","type":"auto","tier_level":"standard","status":{"enabled":true,"tier_picker_enabled":true}},
+ {"id":"hydrafusion","display_name":"High","type":"fusion","tier_level":"high","status":{"enabled":true,"tier_picker_enabled":true}},
+ {"id":"hydrafusion-max","display_name":"Max","type":"fusion","tier_level":"max","status":{"enabled":true,"tier_picker_enabled":true}}
+]}}`
+
+func TestCopilotFusionStandard(t *testing.T) {
+	signIn(t)
+	ForgetCopilotForTest()
+	t.Cleanup(ForgetCopilotForTest)
+	var mu sync.Mutex
+	var routed, sent []string
+	refuse := false
+	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		mu.Lock()
+		defer mu.Unlock()
+		switch r.URL.Path {
+		case "/models":
+			io.WriteString(w, `{"data":[{"id":"gpt-4.1","model_picker_enabled":true,"capabilities":{"type":"chat"}}]}`)
+		case "/meta":
+			if r.Header.Get("X-GitHub-Api-Version") != "2026-09-21" {
+				t.Error("Fusion metadata requested with the wrong API version")
+			}
+			io.WriteString(w, fusionMeta)
+		case "/auto":
+			var q struct {
+				Fusion bool   `json:"fusion"`
+				Tier   string `json:"tier"`
+				Prompt string `json:"prompt"`
+			}
+			json.NewDecoder(r.Body).Decode(&q)
+			if refuse {
+				w.WriteHeader(403)
+				io.WriteString(w, `{"error":{"message":"Fusion is unavailable"}}`)
+				return
+			}
+			kind := "legacy"
+			if q.Fusion {
+				kind = "fusion"
+			}
+			routed = append(routed, kind+" "+q.Tier+" "+q.Prompt)
+			io.WriteString(w, `{"session_token":"`+kind+`-session","selected_model":{"id":"gpt-4.1","supported_endpoints":["/chat/completions"]},"expires_at":`+mustFusionJSON(time.Now().Add(time.Hour).Unix())+`}`)
+		case "/chat/completions":
+			b, _ := io.ReadAll(r.Body)
+			sent = append(sent, bodyModel(b)+" "+r.Header.Get("Copilot-Session-Token"))
+			if strings.HasPrefix(r.Header.Get("Copilot-Session-Token"), "fusion-") && r.Header.Get("X-GitHub-Api-Version") != "2026-08-01" {
+				t.Error("Fusion inference requested with the wrong API version")
+			}
+			io.WriteString(w, `{}`)
+		default:
+			t.Errorf("unexpected fallback to %s", r.URL.Path)
+			w.WriteHeader(500)
+		}
+	}))
+	defer api.Close()
+	tokens := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		json.NewEncoder(w).Encode(map[string]any{"token": "sess", "expires_at": time.Now().Add(time.Hour).Unix(), "endpoints": map[string]string{"api": api.URL}})
+	}))
+	defer tokens.Close()
+	old := CopilotTokenURL
+	CopilotTokenURL = tokens.URL
+	t.Cleanup(func() { CopilotTokenURL = old })
+	p, _ := find(All(), "copilot")
+	ms, err := p.Fetch(context.Background())
+	if err != nil || !slices.ContainsFunc(ms, func(m catalog.Model) bool { return m.ID == "fusion" && m.Name == "Copilot Fusion Standard" }) {
+		t.Fatalf("Fusion Standard missing from models: %+v, %v", ms, err)
+	}
+	send := func(pick string) {
+		t.Helper()
+		ctx, model, err := p.ResolveAuto(WithAutoPrompt(context.Background(), "test prompt"), pick)
+		if err != nil || model != "gpt-4.1" {
+			t.Fatalf("%s resolved to %q: %v", pick, model, err)
+		}
+		body := []byte(`{"model":"` + model + `","messages":[{"role":"user","content":"hi"}]}`)
+		req, _ := http.NewRequest("POST", api.URL+"/chat/completions", nil)
+		if err := p.Sign(ctx, req, Chat, body); err != nil {
+			t.Fatal(err)
+		}
+		SetBody(req, body)
+		res, err := http.DefaultClient.Do(req)
+		if err != nil {
+			t.Fatal(err)
+		}
+		res.Body.Close()
+	}
+	send("auto")
+	send("fusion")
+	send("auto")
+	send("fusion")
+	mu.Lock()
+	if !slices.Equal(routed, []string{"legacy balance test prompt", "fusion balance test prompt"}) || !slices.Equal(sent, []string{"gpt-4.1 legacy-session", "gpt-4.1 fusion-session", "gpt-4.1 legacy-session", "gpt-4.1 fusion-session"}) {
+		t.Errorf("routes: %q; requests: %q", routed, sent)
+	}
+	mu.Unlock()
+	// A provider's model test signs the virtual id directly, without the
+	// gateway's ResolveAuto step. It must keep the Fusion context too.
+	req, _ := http.NewRequest("POST", api.URL+"/chat/completions", nil)
+	if err := p.Sign(context.Background(), req, Chat, []byte(`{"model":"fusion","messages":[]}`)); err != nil {
+		t.Fatal(err)
+	}
+	b, _ := io.ReadAll(req.Body)
+	if bodyModel(b) != "gpt-4.1" || req.Header.Get("Copilot-Session-Token") != "fusion-session" || req.Header.Get("X-GitHub-Api-Version") != "2026-08-01" {
+		t.Fatalf("direct Fusion signing lost routing or billing context")
+	}
+	ctx, model, err := p.ResolveAuto(context.Background(), "fusion")
+	if err != nil {
+		t.Fatal(err)
+	}
+	if !p.Retry(ctx, []byte(`{"model":"`+model+`"}`), 400, []byte(`{"error":{"message":"Requested model not available for session"}}`)) {
+		t.Fatal("an expired Fusion session must be renewed")
+	}
+	// Signing with the old request context renews Fusion, leaving legacy
+	// Auto's cached pick alone.
+	if err := p.Sign(ctx, req, Chat, []byte(`{"model":"gpt-4.1","messages":[]}`)); err != nil {
+		t.Fatal(err)
+	}
+	send("auto")
+	mu.Lock()
+	if len(routed) != 3 || routed[2] != "fusion balance hi" {
+		t.Errorf("session renewal crossed routing modes: %q", routed)
+	}
+	refuse = true
+	mu.Unlock()
+	ForgetCopilotForTest()
+	// Manual selection can be refused while Fusion may still route to the
+	// same model; that refusal must not poison Fusion's routing session.
+	p.Retry(context.Background(), []byte(`{"model":"gpt-4.1"}`), 400, []byte(`{"error":{"code":"model_not_supported"}}`))
+	mu.Lock()
+	refuse = false
+	mu.Unlock()
+	if _, model, err := p.ResolveAuto(context.Background(), "fusion"); err != nil || model != "gpt-4.1" {
+		t.Fatalf("manual selection refusal poisoned Fusion: %q %v", model, err)
+	}
+	ForgetCopilotForTest()
+	mu.Lock()
+	refuse = true
+	mu.Unlock()
+	if _, _, err := p.ResolveAuto(context.Background(), "fusion"); err == nil || !strings.Contains(err.Error(), "Fusion is unavailable") {
+		t.Fatalf("Fusion refusal must fail without legacy fallback: %v", err)
+	}
+}
+
+func TestCopilotFusionMetadata(t *testing.T) {
+	for _, tc := range []struct {
+		name, meta string
+		status     int
+		want       bool
+	}{
+		{"enabled", fusionMeta, 200, true},
+		{"disabled", strings.ReplaceAll(fusionMeta, `"enabled":true`, `"enabled":false`), 200, false},
+		{"hidden", strings.ReplaceAll(fusionMeta, `"tier_picker_enabled":true`, `"tier_picker_enabled":false`), 200, false},
+		{"picker omitted", strings.ReplaceAll(fusionMeta, `,"tier_picker_enabled":true`, ""), 200, true},
+		{"legacy balance", strings.ReplaceAll(fusionMeta, `"tier_level":"standard"`, `"tier_level":"balance"`), 200, false},
+		{"malformed", `{"auto":`, 200, false},
+		{"old service", `{}`, 404, false},
+		{"unavailable", fusionMeta, 503, false},
+	} {
+		t.Run(tc.name, func(t *testing.T) {
+			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+				w.WriteHeader(tc.status)
+				io.WriteString(w, tc.meta)
+			}))
+			defer api.Close()
+			s := copilotSession{Token: "test"}
+			s.Endpoints.API = api.URL
+			if got := copilotHasFusion(context.Background(), copilotApp{}, s); got != tc.want {
+				t.Errorf("Fusion availability = %v, want %v", got, tc.want)
+			}
+		})
+	}
+}
+
+func mustFusionJSON(v any) string {
+	b, _ := json.Marshal(v)
+	return string(b)
+}
diff --git a/internal/provider/copilot_refused.go b/internal/provider/copilot_refused.go
index 4baa71f1b..c24cf8cad 100644
--- a/internal/provider/copilot_refused.go
+++ b/internal/provider/copilot_refused.go
@@ -42,12 +42,13 @@ var copilotSessionGone = lazyre.New(`(?i)not available for session`)
 // then picks another.
 func copilotRefused(ctx context.Context, app copilotApp, model string, status int, body []byte) bool {
 	a, ok := ctx.Value(copilotAutoKey{}).(copilotAutoSession)
+	key := copilotAutoCacheKey(app.Token, a.Fusion || model == CopilotFusion)
 	if status == 400 && copilotSessionGone.Match(body) && ok && a.Model == model && a.Token != "" {
 		// Auto's session isn't taken for its pick any more: it is let
 		// go, and the request sent with one asked anew
 		copilotAutoMu.Lock()
-		if cur, held := copilotAutoSessions[app.Token]; held && cur.Token == a.Token {
-			delete(copilotAutoSessions, app.Token)
+		if cur, held := copilotAutoSessions[key]; held && cur.Token == a.Token {
+			delete(copilotAutoSessions, key)
 		}
 		copilotAutoMu.Unlock()
 		return true
@@ -57,36 +58,36 @@ func copilotRefused(ctx context.Context, app copilotApp, model string, status in
 	}
 	// Auto's: the request the gateway resolved for it, or a model test
 	// asking for "auto" itself
-	auto := ok && a.Model == model || model == CopilotAuto
-	if auto && (model == CopilotAuto || copilotRefuses(app.Token, model)) {
+	auto := ok && a.Model == model || CopilotRoutes(model)
+	if auto && (CopilotRoutes(model) || copilotRefuses(key, model)) {
 		// sent as the pick asked for in its stead (copilotAutoSign)
 		copilotAutoMu.Lock()
-		cur, ok := copilotAutoSessions[app.Token]
+		cur, ok := copilotAutoSessions[key]
 		copilotAutoMu.Unlock()
 		if !ok {
 			return false
 		}
 		model = cur.Model
 	}
-	if model == "" || model == CopilotAuto {
+	if model == "" || CopilotRoutes(model) {
 		return false
 	}
 	if auto {
 		pickRefused(ctx, model, APIError(body, "400"))
 	}
 	copilotRefusedMu.Lock()
-	if copilotRefusedAt[app.Token] == nil {
-		copilotRefusedAt[app.Token] = map[string]time.Time{}
+	if copilotRefusedAt[key] == nil {
+		copilotRefusedAt[key] = map[string]time.Time{}
 	}
-	copilotRefusedAt[app.Token][model] = time.Now()
+	copilotRefusedAt[key][model] = time.Now()
 	copilotRefusedMu.Unlock()
 	if !auto {
 		return false
 	}
 	// Auto's session, or the model standing in for it, is asked anew
 	copilotAutoMu.Lock()
-	if cur, ok := copilotAutoSessions[app.Token]; ok && cur.Model == model {
-		delete(copilotAutoSessions, app.Token)
+	if cur, ok := copilotAutoSessions[key]; ok && cur.Model == model {
+		delete(copilotAutoSessions, key)
 	}
 	copilotAutoMu.Unlock()
 	return true
diff --git a/internal/provider/copilot_refused_test.go b/internal/provider/copilot_refused_test.go
index d8c97e740..769f65936 100644
--- a/internal/provider/copilot_refused_test.go
+++ b/internal/provider/copilot_refused_test.go
@@ -57,6 +57,8 @@ func (c *student371) ServeHTTP(w http.ResponseWriter, r *http.Request) {
 	c.mu.Lock()
 	defer c.mu.Unlock()
 	switch r.URL.Path {
+	case "/meta":
+		w.WriteHeader(404)
 	case "/models":
 		io.WriteString(w, copilot371Models())
 	case "/models/gpt-5.6-sol/policy", "/models/gpt-5.6-terra/policy":
diff --git a/internal/usage/served.go b/internal/usage/served.go
index c878fd45a..130a6df28 100644
--- a/internal/usage/served.go
+++ b/internal/usage/served.go
@@ -68,7 +68,7 @@ func bareModel(m string) string {
 // (RelayRenamed), nor the model at a region's deployment (RegionTail).
 func Swapped(sent, served string) bool {
 	a, b := bareModel(sent), bareModel(served)
-	return a != "" && b != "" && squash(a) != squash(b) && a != "auto" && squash(bareModel(provider.EffortFamily(a))) != squash(b) && !GroupRouted(sent, served) && !ServingName(sent, served) && !RelayRenamed(sent, served) && !VendorAlias(sent, served) && !RegionTail(sent, served)
+	return a != "" && b != "" && squash(a) != squash(b) && !provider.CopilotRoutes(a) && squash(bareModel(provider.EffortFamily(a))) != squash(b) && !GroupRouted(sent, served) && !ServingName(sent, served) && !RelayRenamed(sent, served) && !VendorAlias(sent, served) && !RegionTail(sent, served)
 }
 
 // regionTail is a region a vendor's id names its deployment of a model
-- 
2.50.1 (Apple Git-155)

```

</details>

**Branch with the commit**: [`hunt-20261111-rf-5599`](https://github.com/ggbdpq/magpie/tree/hunt-20261111-rf-5599) (head `42f09641d72245d4173189ee8f47b0b312378e8a`), rebased onto current `upstream/main` (`0d0a1a567`); on a fresh checkout at that tip `git am` applies it as is (replayed on a detached worktree, tree identical). Author kept as `Ki (Kymorphius)` — the commit is theirs; the fixture's `/meta` branch is the only line added in the carry, marked with the issue number.

Verification this round (on `0d0a1a567` + this commit, `GOCACHE` pinned):

| Check | Result |
| --- | --- |
| `go test -race -tags nogui ./internal/provider ./internal/gateway ./internal/usage -run 'TestCopilot\|TestSwapped' -count=3` | ok ×3 (13.2s / 8.5s / 2.6s per pass) |
| `TestCopilotFusionStandard` | green with the patch; ablation (the `/meta` capability probe made to answer "no Fusion", build intact) red with the carry's original failure form: `Fusion Standard missing from models`; restored: green |
| `TestCopilotAccountsWithOtherModels` (main's newer per-account lists test) | ok — green at the parent too, red only through the `/meta` probe's recording, fixed by the fixture branch above |
| `gofmt -l` on the touched files | prints nothing |
| `go vet -tags nogui ./internal/provider/ ./internal/gateway/ ./internal/usage/` | clean |
| `go build -tags nogui ./...` darwin / `GOOS=linux` / `GOOS=windows` | clean |

**Siblings**: `CopilotRoutes` gates the two `/auto`-shaped selections (legacy `auto` and `fusion`) at the attempt path and `autoPicks`; the Fusion session/refusal separation lives in `copilot_auto.go`/`copilot_refused.go` beside the legacy Auto cache, keyed with the fusion flag so neither poisons the other; `usage/served.go` counts a Fusion-picked model as routed. Legacy `copilot/auto` paths are unchanged where the model is not `fusion`. No promotional price is saved as a model price (the reporter's design, kept).

**Not verified**: a real Copilot Fusion Standard account (the reporter ran the live wire checks on v0.1.3190 — the 70% billing comparison and the session-token flow are theirs, not re-run here; the fake CAPI covers the protocol shapes); High/Max tiers, intentionally out of the patch.

**Attribution**: the fix is @Kymorphius's, carried and verified by me; AI-assisted verification (GLM-5.3-Flash via ZCode). Please keep their authorship (`Ki` / Kymorphius) or add `Co-authored-by: Kymorphius` alongside.
