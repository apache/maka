A Mistral plan's month can now be read from its key. Mistral's subscription includes two monthly allowances — the API one and a separate Vibe Code one — and admin.mistral.ai/subscription shows both, but a key could ask for none of it, so a Mistral provider had no card on the Usage page or in the menu bar (#5087). Credit @ninondev for the exact shapes: the two quotas, their calendar-month reset, and the Credits-vs-allowance split are all spelled out in the report.

**The source**

Both numbers are on a public, documented endpoint. Mistral's own OpenAPI spec (docs.mistral.ai/openapi.yaml, of 2026-11-05) lists `GET /v1/billing/budget` (tag `beta.billing`): the current period's `api_budget` and `vibe_budget`, each with `usage_percentage`, `initial_budget`, `currency`, `reset_at` — the spec's own words are "the organization's API and Vibe budgets for the current billing period", which is the subscription page's two cards. It takes the key in `x-api-key`, not in `Authorization` as the inference API takes it (the spec's `DashboardContextAuth` scheme) — the same key magpie already holds. `GET /v1/billing/subscription`, asked beside it, names the plan and tells whether pay-as-you-go is on.

**The fix**

The two budgets become two windows on the key's card, the way Ollama Cloud's included allowance (#1888) and the other keyed plans are cards: **API** first (what the month has spent of its total, in the budget's currency, renewing at `reset_at`), **Vibe Code** set apart from it — Vibe running out stops no API request. When pay-as-you-go is on, a budget spent past draws on the prepayment, so a spent API budget no longer stops the key either (the same rule Ollama's spent allowance with credits bought follows); the plan's name is shown with the card. An org with no budget (a free or pay-as-you-go one) tells none, and gets no card. The prepaid **Credits** of the Billing page stay off the card: no documented, key-taken endpoint returns them — the usage queries that would price spend need an admin-scoped key, which the spec says ordinary workspace/inference keys are rejected by.

<details>
<summary>Patch (0001-provider-show-Mistral-s-included-API-and-Vibe-Code-a.patch)</summary>

```diff
From 2eceed5c2f6a60a8dec674a648d8f1f1254b0da8 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 5 Nov 2026 00:50:34 +0800
Subject: [PATCH] provider: show Mistral's included API and Vibe Code
 allowances on a plan key's card

A Mistral subscription includes two monthly allowances, and a key could
ask for none of it: a Mistral provider had no card on the Usage page or
in the menu bar, though admin.mistral.ai/subscription shows both
(ninondev, #5087). The dashboard's billing query, GET /v1/billing/
budget, tells both to the key: what the plan's included API usage has
spent of its own total, and what its separate Vibe Code usage has of
another, each with the moment the month is up. The key goes in
x-api-key there, not in Authorization as the inference API takes it
(the spec's DashboardContextAuth), so planQuotaSource grew the xkey to
say so. The plan's own query, /v1/billing/subscription, asked beside
the budgets, names the plan and tells whether pay-as-you-go is on: a
budget spent past draws on the prepayment then, so using it up doesn't
stop the key (Aside), as Ollama Cloud's spent allowance with credits
bought doesn't. The Vibe Code budget never stops an API request. An org
with no budget (a free or pay-as-you-go one) tells none, and gets no
card. The prepaid Credits of the Billing page the spec tells to no key,
so they stay off the card.

Windows of a reply (TestReadMistralBudget, TestReadMistralBudgetMissing):
both budgets, one alone, none, a budget with no currency derived. A
key's card (TestMistralKeyWindows, TestMistralKeyWindowsNoSubscription):
the key in x-api-key alone on both asks, the plan's name and
pay-as-you-go carried onto the windows, the budgets standing when the
plan query fails. TestPlanQuotaSource rows for api.mistral.ai.
internal/provider, -tags nogui -count=1: green. gofmt, vet, go build
./...: clean.

Not asked of a real Mistral account: the reply shapes here are the
OpenAPI spec's own (docs.mistral.ai/openapi.yaml, of 2026-11-05), and
whether an org's ordinary key passes the dashboard's
see_org_inference_usage check is the reporter's to confirm.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/mistral_plan.go      | 115 +++++++++++++++++++++++
 internal/provider/mistral_plan_test.go | 124 +++++++++++++++++++++++++
 internal/provider/planquota.go         |  37 ++++++--
 internal/provider/planquota_test.go    |   1 +
 4 files changed, 267 insertions(+), 10 deletions(-)
 create mode 100644 internal/provider/mistral_plan.go
 create mode 100644 internal/provider/mistral_plan_test.go

diff --git a/internal/provider/mistral_plan.go b/internal/provider/mistral_plan.go
new file mode 100644
index 000000000..a0eb3eb48
--- /dev/null
+++ b/internal/provider/mistral_plan.go
@@ -0,0 +1,115 @@
+package provider
+
+// Mistral tells a key its month's budgets at api.mistral.ai/v1/billing/
+// budget (#5087): what the plan's included API usage has spent of its
+// own total, and what its separate Vibe Code usage has of another, with
+// the moment both come back (admin.mistral.ai/subscription shows the
+// same). The key goes in x-api-key, the dashboard's own header, not in
+// Authorization as the inference API takes it. The plan's own query,
+// /v1/billing/subscription, names the plan and tells whether
+// pay-as-you-go is on: a budget spent past then draws on the
+// prepayment, so using it up doesn't stop the key.
+
+import (
+	"context"
+	"encoding/json"
+	"time"
+)
+
+// mistralBudgetURL is the budgets query, a var for tests to point at a
+// server of their own.
+var mistralBudgetURL = "https://api.mistral.ai/v1/billing/budget"
+
+// mistralSubscriptionURL is the plan's own query, likewise.
+var mistralSubscriptionURL = "https://api.mistral.ai/v1/billing/subscription"
+
+// mistralBudget is one of the two budgets of a billing period
+// (BudgetDetail in Mistral's OpenAPI spec): the share spent, the total,
+// its currency, and when the month is up. The currency is left out when
+// no budget could be derived for the period.
+type mistralBudget struct {
+	UsedPct  float64 `json:"usage_percentage"`
+	Total    float64 `json:"initial_budget"`
+	Currency string  `json:"currency"`
+	ResetAt  string  `json:"reset_at"`
+	Payg     bool    `json:"payg_enabled"`
+}
+
+// mistralBudgets is /v1/billing/budget. Either budget is left out of a
+// reply that has none of it, and an org with no budget (a free or
+// pay-as-you-go one) is told none at all.
+type mistralBudgets struct {
+	API  *mistralBudget `json:"api_budget"`
+	Vibe *mistralBudget `json:"vibe_budget"`
+}
+
+// readMistralBudget is the budgets as windows: the plan's included API
+// usage first, the Vibe Code usage beside it (Aside: Vibe running out
+// stops no API request), each what the month has spent of its total and
+// when it comes back. A reply with neither budget has no card.
+func readMistralBudget(b []byte) (string, []QuotaWindow, error) {
+	var r mistralBudgets
+	if err := json.Unmarshal(b, &r); err != nil {
+		return "", nil, err
+	}
+	out := []QuotaWindow{}
+	if w := r.API.window("API", false); w != nil {
+		out = append(out, *w)
+	}
+	if w := r.Vibe.window("Vibe Code", true); w != nil {
+		out = append(out, *w)
+	}
+	return "", out, nil
+}
+
+// window is the budget as a window, nil for one the account hasn't: a
+// budget with no total is none. One whose currency wasn't derived shows
+// its share alone.
+func (m *mistralBudget) window(name string, aside bool) *QuotaWindow {
+	if m == nil || m.Total <= 0 {
+		return nil
+	}
+	w := &QuotaWindow{Name: name, Used: min(100, max(0, m.UsedPct))}
+	if m.Currency != "" {
+		w.Amount = min(m.Total, max(0, m.Total*m.UsedPct/100))
+		w.Limit = m.Total
+		w.Unit = m.Currency
+	}
+	if t, err := time.Parse(time.RFC3339, m.ResetAt); err == nil {
+		w.ResetsAt = &t
+	}
+	w.Aside = aside
+	return w
+}
+
+// mistralKeyWindows is a Mistral key's card: the month's budgets, and,
+// asked beside them, the plan's name and whether pay-as-you-go is on —
+// the API budget spent past draws on the prepayment then, so using it
+// up doesn't stop the key. The plan query failing leaves the budgets as
+// they are: its name is a label, not the card. An org with no plan
+// tells no budgets, and gets no card.
+func mistralKeyWindows(ctx context.Context, src planQuotaSource, key string) (string, []QuotaWindow, error) {
+	b, err := planBody(ctx, src, key)
+	if err != nil {
+		return "", nil, err
+	}
+	plan, ws, err := readMistralBudget(b)
+	if err != nil || len(ws) == 0 {
+		return plan, ws, err
+	}
+	if sb, serr := planBody(ctx, planQuotaSource{mistralSubscriptionURL, false, true, nil, false}, key); serr == nil {
+		var s struct {
+			Plan string `json:"plan_name"`
+			Payg bool   `json:"payg_enabled"`
+		}
+		if json.Unmarshal(sb, &s) == nil {
+			plan = s.Plan
+			for i := range ws {
+				if ws[i].Name != "Vibe Code" {
+					ws[i].Aside = s.Payg
+				}
+			}
+		}
+	}
+	return plan, ws, nil
+}
diff --git a/internal/provider/mistral_plan_test.go b/internal/provider/mistral_plan_test.go
new file mode 100644
index 000000000..7ed32de33
--- /dev/null
+++ b/internal/provider/mistral_plan_test.go
@@ -0,0 +1,124 @@
+package provider
+
+import (
+	"context"
+	"net/http"
+	"net/http/httptest"
+	"strings"
+	"testing"
+	"time"
+)
+
+// mistralBudgetReply is /v1/billing/budget for a plan with both its
+// budgets, in euros, as Mistral's OpenAPI spec gives BudgetDetail.
+const mistralBudgetReply = `{
+  "vibe_budget": {"usage_percentage": 42.5, "initial_budget": 300.0,
+                  "currency": "EUR", "reset_at": "2026-12-01T00:00:00Z", "payg_enabled": false},
+  "api_budget":  {"usage_percentage": 10, "initial_budget": 25.0,
+                  "currency": "EUR", "reset_at": "2026-12-01T00:00:00Z", "payg_enabled": false}
+}`
+
+// The plan's included API usage is the first window, its Vibe Code usage
+// the second, apart from it (Aside: Vibe running out stops no API
+// request), each what the month has spent of its own total and when the
+// month is up.
+func TestReadMistralBudget(t *testing.T) {
+	plan, ws, err := readMistralBudget([]byte(mistralBudgetReply))
+	if err != nil || plan != "" || len(ws) != 2 {
+		t.Fatalf("%v %q %+v", err, plan, ws)
+	}
+	reset := time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC)
+	w := ws[0]
+	if w.Name != "API" || w.Amount != 2.5 || w.Limit != 25 || w.Unit != "EUR" || w.Used != 10 ||
+		w.ResetsAt == nil || !w.ResetsAt.Equal(reset) || w.Aside {
+		t.Errorf("api: %+v", w)
+	}
+	v := ws[1]
+	if v.Name != "Vibe Code" || v.Amount != 127.5 || v.Limit != 300 || v.Unit != "EUR" || v.Used != 42.5 || !v.Aside {
+		t.Errorf("vibe: %+v", v)
+	}
+}
+
+// What a reply leaves out or has none of is no window, and an org with
+// no budget (a free or pay-as-you-go one) has no card.
+func TestReadMistralBudgetMissing(t *testing.T) {
+	_, ws, err := readMistralBudget([]byte(`{"vibe_budget": null,
+		"api_budget": {"usage_percentage": 3, "initial_budget": 20, "currency": "USD", "reset_at": "2026-12-01T00:00:00Z"}}`))
+	if err != nil || len(ws) != 1 || ws[0].Name != "API" || ws[0].Unit != "USD" {
+		t.Fatalf("%v %+v", err, ws)
+	}
+	_, ws, err = readMistralBudget([]byte(`{"api_budget": {"usage_percentage": 0, "initial_budget": 0,
+		"currency": null, "reset_at": "2026-12-01T00:00:00Z"}, "vibe_budget": null}`))
+	if err != nil || len(ws) != 0 {
+		t.Fatalf("no budget: %v %+v", err, ws)
+	}
+	// a budget with no currency derived shows its share alone
+	_, ws, err = readMistralBudget([]byte(`{"api_budget": {"usage_percentage": 30, "initial_budget": 10,
+		"currency": null, "reset_at": "2026-12-01T00:00:00Z"}}`))
+	if err != nil || len(ws) != 1 || ws[0].Unit != "" || ws[0].Amount != 0 || ws[0].Limit != 0 || ws[0].Used != 30 {
+		t.Fatalf("no currency: %v %+v", err, ws)
+	}
+}
+
+// Both queries take the key in x-api-key alone, the plan's name comes
+// with the budgets, and pay-as-you-go on leaves a spent API budget
+// going (it draws on the prepayment), while the Vibe Code budget never
+// stops an API request.
+func TestMistralKeyWindows(t *testing.T) {
+	var seen []string
+	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		seen = append(seen, r.URL.Path+" x-api-key:"+r.Header.Get("x-api-key")+" auth:"+r.Header.Get("Authorization"))
+		switch r.URL.Path {
+		case "/v1/billing/budget":
+			w.Write([]byte(mistralBudgetReply))
+		case "/v1/billing/subscription":
+			w.Write([]byte(`{"plan_name":"INDIVIDUAL","payg_enabled":true,"vibe_payg_enabled":false,"enterprise":false}`))
+		default:
+			w.WriteHeader(http.StatusNotFound)
+		}
+	}))
+	defer srv.Close()
+	budget, subscription := mistralBudgetURL, mistralSubscriptionURL
+	mistralBudgetURL, mistralSubscriptionURL = srv.URL+"/v1/billing/budget", srv.URL+"/v1/billing/subscription"
+	defer func() { mistralBudgetURL, mistralSubscriptionURL = budget, subscription }()
+	src := planQuotaSource{mistralBudgetURL, false, true, readMistralBudget, false}
+	plan, ws, err := mistralKeyWindows(context.Background(), src, "k1")
+	if err != nil || plan != "INDIVIDUAL" || len(ws) != 2 {
+		t.Fatalf("%v %q %+v", err, plan, ws)
+	}
+	if !ws[0].Aside {
+		t.Error("pay-as-you-go on: a spent API budget stops the key")
+	}
+	if !ws[1].Aside {
+		t.Error("the Vibe Code budget out stops an API request")
+	}
+	if len(seen) != 2 {
+		t.Fatalf("asks: %q", seen)
+	}
+	for _, s := range seen {
+		if !strings.Contains(s, "x-api-key:k1") || !strings.HasSuffix(s, "auth:") {
+			t.Errorf("ask: %s", s)
+		}
+	}
+}
+
+// The plan's own query failing leaves the budgets as they are: its name
+// is a label, not the card.
+func TestMistralKeyWindowsNoSubscription(t *testing.T) {
+	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		if r.URL.Path == "/v1/billing/subscription" {
+			w.WriteHeader(http.StatusInternalServerError)
+			return
+		}
+		w.Write([]byte(mistralBudgetReply))
+	}))
+	defer srv.Close()
+	budget, subscription := mistralBudgetURL, mistralSubscriptionURL
+	mistralBudgetURL, mistralSubscriptionURL = srv.URL+"/v1/billing/budget", srv.URL+"/v1/billing/subscription"
+	defer func() { mistralBudgetURL, mistralSubscriptionURL = budget, subscription }()
+	src := planQuotaSource{mistralBudgetURL, false, true, readMistralBudget, false}
+	plan, ws, err := mistralKeyWindows(context.Background(), src, "k1")
+	if err != nil || plan != "" || len(ws) != 2 || ws[0].Aside {
+		t.Errorf("%v %q %+v api aside %v", err, plan, ws, len(ws) > 0 && ws[0].Aside)
+	}
+}
diff --git a/internal/provider/planquota.go b/internal/provider/planquota.go
index 7459f984b..93c3e8901 100644
--- a/internal/provider/planquota.go
+++ b/internal/provider/planquota.go
@@ -2,7 +2,8 @@ package provider
 
 // A plan bought with an API key — Zhipu's GLM Coding Plan (and Z.ai's),
 // Kimi Code, OpenCode Go, a Command Code plan, MiniMax's Coding (Token)
-// Plan, Ollama Cloud's included allowance, StepFun's Step Plan, Volcengine Ark's Coding and Agent Plans and
+// Plan, Ollama Cloud's included allowance, Mistral's included API and
+// Vibe Code budgets, StepFun's Step Plan, Volcengine Ark's Coding and Agent Plans and
 // Tencent Cloud's Token Plan 企业版 — has windows of allowance like a
 // subscription's, which the vendor tells to the key (StepFun only to a
 // sign-in, stepfun_plan.go; Volcengine and Tencent Cloud only to the
@@ -27,7 +28,11 @@ import (
 type planQuotaSource struct {
 	url    string
 	bearer bool // Zhipu takes the bare key as the Authorization
-	read   func(body []byte) (plan string, ws []QuotaWindow, err error)
+	// xkey, when set, sends the key in x-api-key alone: Mistral's
+	// billing queries take it there, not in Authorization (its OpenAPI
+	// spec's DashboardContextAuth)
+	xkey bool
+	read func(body []byte) (plan string, ws []QuotaWindow, err error)
 	// sure is set when the provider is a plan and not just the vendor: a
 	// pay-as-you-go GLM key has no windows to tell, and saying so on a card
 	// would only be noise
@@ -41,33 +46,37 @@ func planQuotaSourceOf(p Provider) (planQuotaSource, bool) {
 			// Go at Zen's gateway or at the inference API, the URL
 			// models.dev and Go's docs give since October 2026: the same
 			// key, told its windows at the same usage query
-			return planQuotaSource{"https://opencode.ai/zen/go/v1/usage", true, readOpenCodeGo, true}, true
+			return planQuotaSource{"https://opencode.ai/zen/go/v1/usage", true, false, readOpenCodeGo, true}, true
 		}
 		switch hostOf(base) {
 		case "open.bigmodel.cn":
-			return planQuotaSource{"https://open.bigmodel.cn/api/monitor/usage/quota/limit", false, readZhipuPlan, coding}, true
+			return planQuotaSource{"https://open.bigmodel.cn/api/monitor/usage/quota/limit", false, false, readZhipuPlan, coding}, true
 		case "api.z.ai":
-			return planQuotaSource{"https://api.z.ai/api/monitor/usage/quota/limit", false, readZhipuPlan, coding}, true
+			return planQuotaSource{"https://api.z.ai/api/monitor/usage/quota/limit", false, false, readZhipuPlan, coding}, true
 		case "api.kimi.com", "api.kimi.ai":
 			if strings.Contains(base, "/coding") {
-				return planQuotaSource{strings.TrimSuffix(kimiCodeBase(base), "/") + "/usages", true, readKimiCode, true}, true
+				return planQuotaSource{strings.TrimSuffix(kimiCodeBase(base), "/") + "/usages", true, false, readKimiCode, true}, true
 			}
 		case "api.commandcode.ai":
 			// a plan's key, from Studio or its sign-in, works on the keyed
 			// preset too, and is told the plan's 5-hour and weekly windows;
 			// a pay-as-you-go key has none, and no card
-			return planQuotaSource{"https://api.commandcode.ai/alpha/billing/credits", true, readCommandCodePlan, false}, true
+			return planQuotaSource{"https://api.commandcode.ai/alpha/billing/credits", true, false, readCommandCodePlan, false}, true
+		case "api.mistral.ai":
+			// a plan key's month's included budgets (#5087); an org with
+			// no plan tells none, and gets no card
+			return planQuotaSource{mistralBudgetURL, false, true, readMistralBudget, false}, true
 		case "api.minimaxi.com", "api.minimax.cn", "api.minimax.io":
 			// a Coding Plan key (sk-cp-…) is told its windows; a
 			// pay-as-you-go key isn't, and gets no card (#387).
 			// api.minimax.cn is MiniMax China's host since mmx-cli
 			// 8746d48f (2026-09-28), beside api.minimaxi.com, and
 			// answers the same query
-			return planQuotaSource{"https://" + hostOf(base) + "/v1/token_plan/remains", true, readMiniMaxPlan, false}, true
+			return planQuotaSource{"https://" + hostOf(base) + "/v1/token_plan/remains", true, false, readMiniMaxPlan, false}, true
 		case "ollama.com":
 			// Ollama Cloud's included allowance (#1888); a key with none
 			// gets no card
-			return planQuotaSource{ollamaBalanceURL, true, readOllamaPlan, false}, true
+			return planQuotaSource{ollamaBalanceURL, true, false, readOllamaPlan, false}, true
 		}
 	}
 	return planQuotaSource{}, false
@@ -595,7 +604,11 @@ func planBody(ctx context.Context, src planQuotaSource, key string) ([]byte, err
 	if err != nil {
 		return nil, err
 	}
-	if src.bearer {
+	if src.xkey {
+		// the dashboard's queries take the key in x-api-key, not in
+		// Authorization (Mistral's billing ones do)
+		req.Header.Set("x-api-key", key)
+	} else if src.bearer {
 		req.Header.Set("Authorization", "Bearer "+key)
 	} else {
 		req.Header.Set("Authorization", key)
@@ -700,6 +713,10 @@ func planKeyWindows(ctx context.Context, p Provider, src planQuotaSource, key st
 		plan, ws, err = cmdKeyWindows(ctx, src, key)
 		return plan, ws, false, err
 	}
+	if hostOf(src.url) == "api.mistral.ai" {
+		plan, ws, err = mistralKeyWindows(ctx, src, key)
+		return plan, ws, false, err
+	}
 	plan, ws, err = planWindows(ctx, src, key)
 	// a key refused is refused as a team's too
 	if zhipu := strings.HasSuffix(src.url, "/api/monitor/usage/quota/limit"); zhipu && (err != nil || len(ws) == 0) && !zhipuKeyRefusedErr(err) {
diff --git a/internal/provider/planquota_test.go b/internal/provider/planquota_test.go
index 6677474d5..e726e7b9c 100644
--- a/internal/provider/planquota_test.go
+++ b/internal/provider/planquota_test.go
@@ -43,6 +43,7 @@ func TestPlanQuotaSource(t *testing.T) {
 		{Provider{Anthropic: "https://api.minimax.io/anthropic"}, "https://api.minimax.io/v1/token_plan/remains", true, false},
 		// MiniMax China's host since mmx-cli 8746d48f
 		{Provider{Chat: "https://api.minimax.cn/v1", Anthropic: "https://api.minimax.cn/anthropic"}, "https://api.minimax.cn/v1/token_plan/remains", true, false},
+		{Provider{Chat: "https://api.mistral.ai/v1", Anthropic: "https://api.mistral.ai"}, "https://api.mistral.ai/v1/billing/budget", true, false},
 		{Provider{Chat: "https://api.deepseek.com"}, "", false, false},
 		{Provider{Chat: "https://ollama.com/v1", Anthropic: "https://ollama.com"}, "https://ollama.com/api/balance", true, false},
 		{Provider{Chat: "http://localhost:11434/v1"}, "", false, false}, // a local Ollama
-- 
2.50.1 (Apple Git-155)

```

</details>

SHA-256 (first 16): `30c8f1653e302cf0`

**Verification**

| Check | Result |
| --- | --- |
| Windows of a reply — both budgets, one alone, none, a budget with no currency derived (`TestReadMistralBudget`, `TestReadMistralBudgetMissing`) | ok; the reply shapes are the spec's own schema examples |
| A key's card over both asks — key in `x-api-key` alone on each, plan name shown, payg → the API window no longer stops the key, budgets standing when the plan query fails (`TestMistralKeyWindows`, `TestMistralKeyWindowsNoSubscription`) | ok |
| `planQuotaSourceOf` rows for `api.mistral.ai` (`TestPlanQuotaSource`) | ok |
| Ablation: the `api.mistral.ai` case removed | red (`got "" ok=false`); restored, ok |
| Ablation: the `x-api-key` branch removed | red (key went out in `Authorization` instead); restored, ok |
| `go test -tags nogui -count=1` full `internal/provider` | ok (111s) |
| `gofmt -l`, `go vet -tags nogui ./internal/provider/`, `go build ./...` | clean |

Sibling faces checked, none touched: the balance route (`balanceSourceOf`, `KeyBalances`) has no Mistral entry and keeps none — Mistral's Credits are told to no key, so a balance card there would be noise; the editor's own Balance URL field works as for any vendor; `keyWindows` (routing) and `PlanQuotas` (Usage page, menu bar) pick the card up through the same `planQuotaSourceOf` the other keyed plans use, with no GUI change. Failure semantics follow the keyed-plan family (`sure=false`): a key whose budgets were never read shows no card when a read fails, a card read before keeps its last reading (as a vendor failing a while does), and a key refused past a first read says the vendor's own words.

**Not verified**

Nothing was asked of a real Mistral subscription account — I have none. The reply shapes are the spec's own schemas; what they leave open is whether an ordinary API key of an org passes the dashboard's `see_org_inference_usage` check on `/v1/billing/budget` — the one thing @ninondev hadn't checked either, so what the card says on a real plan (or the refusal it names) is the confirmation this still waits for. `reset_at`'s first-of-month reading and the budget totals' currency on an INDIVIDUAL plan are spec-side only.

AI use: this patch was written by GLM-5.3-Flash (ZCode) on ggbdpq's behalf; keep its author ggbdpq (or add Co-authored-by: ggbdpq <ggbdpq@gmail.com>) when applying.

Branch: https://github.com/ggbdpq/magpie/tree/fix/5087-mistral-allowance (head 2eceed5c2f6a60a8dec674a648d8f1f1254b0da8, rebased on upstream/main d17a0b3ca; `git am -3` of the patch tested on a clean tree at that tip, applies as is)
