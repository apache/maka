**Fix** — `?period=` that no period parses to is refused 400 (naming the shapes that work) instead of being silently answered with 30 days; `docs/reference.md` now says the values the HTTP layer actually takes.

Branch: https://github.com/ggbdpq/magpie/tree/hunt-20261111-b-5985-period-400 (head `392c6b3bf`)

## What happens

As the report shows, `PeriodOf` (`internal/usageapi/usageapi.go`) answered any value `usage.Period.Known()` rejects with `usage.Month`, and both the gateway (`/v1/magpie/usage`, `/v1/magpie/usage/requests`) and the GUI (`/api/usage`, `/api/usage/requests`, the requests CSV routes) passed every `?period=` through it. Reproduced on top of `db0f2f20d` exactly as the report's table says: `period=week` → 200 with `"period":"30d"`.

Two independent callers were misled, and only one of them could see it:

- An app writing `period=week` from `docs/reference.md` — which said `period=<today|week|month|all>` while the HTTP layer (`usage.Period`, `internal/usage/usage.go`) has `Week = "7d"`, `Month = "30d"` since #1492 — got 30 days as if it had asked for a month. `gateway-routing.md:1220` says `today|7d|30d|all`, so the two pages disagreed.
- The response's `period` field carries the effective value, so the substitution is only visible by re-reading what you asked for — no error, no signal.

## Root cause

The fallback was written as a convenience in the one function every reader shares (`PeriodOf`), but nothing can depend on it: a caller that asks for a period magpie doesn't know and receives a different period's data has been answered with the wrong answer, not an approximation. The comment even documented it ("30 days for anything else") — a documented wrong answer is still a wrong answer when the request was explicit.

## The fix

`PeriodOf` now returns `(usage.Period, error)`:

- **No value at all** (`""`, the parameter left out) keeps the month it has always defaulted to — a missing parameter is not a misspelled one.
- **A value that parses** (`today|7d|30d|all`, a `from..to` day range, `last:<duration>`) is itself.
- **Anything else** is an error: `unknown period "week": want today|7d|30d|all, a from..to day range like 2026-11-08..2026-11-09, or last:<duration>`.

All seven HTTP call sites (gateway 2 handlers, GUI 4 handlers) turn that error into a 400 — the gateway with its `writeError` shape, the GUI with its `fail` shape. The CLI needed nothing: `usage_cli.go` already refused unknown names (`case "7d", "week"` are its own aliases, resolved before any HTTP call).

`docs/reference.md` now says `period=<today|7d|30d|all>`, names the `last:` and `from..to` shapes, and says what a misspelled one gets.

**On `?since=`** (the report's second point): left alone. It is a not-implemented parameter, and an unimplemented query parameter being ignored is HTTP's usual contract; with an unparseable `period` now a 400, the two cases no longer fold into one silent fallback. If `since` is ever wanted, that is a feature to ask for on its own.

## Verification

| Check | Result |
| --- | --- |
| Red before the fix | `period=week` → 200 `"period":"30d"` on gateway and GUI (report's table reproduced) |
| Green after | `week`, `month`, `1d`, `24h`, `bogus`, `a..b..c`, `last:0` → 400 naming the shapes; no `period`, `period=`, `today|7d|30d|all`, `last:24h`, `from..to` → 200 |
| Contract test | `TestPeriodOfKnownOrError` covers `PeriodOf`'s accept/refuse split |
| Handler tests | `TestUsagePeriodUnknownIsRefused` (gateway), `TestUsagePeriodUnknownRefusedAPI` (GUI) |
| Packages | `usageapi`, `gateway` (usage-domain), `gui` targeted runs pass; `gofmt` clean; `go vet` clean |
| Ablation | reverting only the three product files turns both handler tests red again (200 ≠ 400) |

**Siblings**: `PeriodOf` is the one period seam; every reader goes through it, and all seven HTTP call sites are covered. The other query parsers were left as they are on purpose: `FilterOf` (route/model/agent…), `viaOf`, `offset`/`limit` are optional filters where an unparseable value means "no filter", not "a different dataset"; `usage.Zone` falls back to `Local` for any text (zone.go, "not kept: any text can be asked for") — it shapes buckets, never which calls are counted. The CLI's `usage` command already failed closed. No other place answers one period's data for another's name.

**When the read fails**: `PeriodOf` reads the query string, not a file. A request with no `period` key gets the month default it always got; the GUI page always sends one of its own four presets or a picked range (page.js `PERIODS`, `app.js` initialises to `today`), so no internal caller lands on the 400.

**Source**: internal/usageapi/usageapi.go (`PeriodOf`), internal/gateway/usage_api.go, internal/gui/usage.go, internal/usage/usage.go (Period constants), internal/usage/period_range.go (`Known`), internal/cli/usage_cli.go, docs/reference.md at upstream/main `db0f2f20d4dda003c153922a94932ab8d212d96f`.
**Not verified**: the gateway package's full suite does not finish on this machine within the time a test run is given (its usage domain — `TestUsage*|TestOwnPage|TestLedger` — passes, as do my two handler tests; the GUI package's full suite was run on both this branch and the base commit and fails the same three pre-existing tests on both, `TestProxyCheckSaysAProxyPassedBy` among them, so none of the GUI failures are new); no live shared-magpie caller was asked whether it sends `week`/`month` today (if one does, it was already getting 30 days it never asked for, and the 400 is the honest answer).
**Attribution**: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
**Patch**: <details><summary>patch: usage: a period the HTTP layer can't parse is refused, not another's data (#5985) — git am applies it as is; SHA-256 first 16: 6a29b46a6b7dc5f4</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 11 Nov 2026 00:46:36 +0800
Subject: [PATCH] usage: a period the HTTP layer can't parse is refused, not
 another's data
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

?period= that no period parses to was answered with 30 days, as if the
caller had asked for them (#5985): an app asking for a period it read
from docs/reference.md — which named week and month, values the HTTP
layer never took — had no signal but the response's own period field.
PeriodOf now errors on a value no period parses to, and the gateway and
the GUI refuse it 400 naming the shapes that work; no period at all
keeps the month it has always answered. reference.md now says
today|7d|30d|all, with the last: and from..to shapes.

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/reference.md                     |  8 +++--
 internal/gateway/usage_api.go         | 16 ++++++++--
 internal/gateway/usage_period_test.go | 42 +++++++++++++++++++++++++
 internal/gui/usage.go                 | 26 +++++++++++++---
 internal/gui/usage_period_api_test.go | 35 +++++++++++++++++++++
 internal/usageapi/period_of_test.go   | 45 +++++++++++++++++++++++++++
 internal/usageapi/usageapi.go         | 17 +++++++---
 7 files changed, 176 insertions(+), 13 deletions(-)
 create mode 100644 internal/gateway/usage_period_test.go
 create mode 100644 internal/gui/usage_period_api_test.go
 create mode 100644 internal/usageapi/period_of_test.go

diff --git a/docs/reference.md b/docs/reference.md
index cf63cee57..32f3b43bb 100644
--- a/docs/reference.md
+++ b/docs/reference.md
@@ -2860,10 +2860,14 @@ read-only key is refused 403 `gateway_key_read_only` and a held key 403
 `gateway_key_held`.
 
 An app of your own can read the Usage page's numbers too.
-`GET /v1/magpie/usage?period=<today|week|month|all>` is the page's summary,
+`GET /v1/magpie/usage?period=<today|7d|30d|all>` is the page's summary,
 the same JSON as the window's `/api/usage` (`path` is left out for another
 machine), with every session in `sessions` where the window's lists the
-top 100 by tokens; `sessionCount` is how many there are. `GET /v1/magpie/usage/requests` is its requests a page at a time
+top 100 by tokens; `sessionCount` is how many there are. A `period` can
+also be a rolling window (`last:24h`) or days picked (`2026-11-08..2026-11-09`,
+either end naming its minute as `2026-11-08T09:30`); with no `period` at
+all it is 30 days, and one that names none of these is refused 400.
+`GET /v1/magpie/usage/requests` is its requests a page at a time
 (`offset`, `limit` up to 500), with the same filters as the Requests log:
 `period`, `day`, `agent`, `provider`, `model`, `account`, `callerKey`,
 `purpose`, `failed`, `retried`, `q`, `via`, `computer`. `callerKey=none`
diff --git a/internal/gateway/usage_api.go b/internal/gateway/usage_api.go
index 2ddbfa3c4..8284967d6 100644
--- a/internal/gateway/usage_api.go
+++ b/internal/gateway/usage_api.go
@@ -62,7 +62,12 @@ func (s *Server) usageSummary(w http.ResponseWriter, r *http.Request) {
 	if refuseHeld(w, r, "this gateway key is held to a budget, models or accounts, so it is told its own calls alone: GET /v1/magpie/usage/requests") {
 		return
 	}
-	out := usageapi.State(usageapi.PeriodOf(r.URL.Query().Get("period")))
+	p, err := usageapi.PeriodOf(r.URL.Query().Get("period"))
+	if err != nil {
+		writeError(w, provider.Chat, http.StatusBadRequest, err.Error())
+		return
+	}
+	out := usageapi.State(p)
 	if !local(r) {
 		out.Path = "" // where the log is on this machine
 	}
@@ -75,14 +80,19 @@ func (s *Server) usageRequests(w http.ResponseWriter, r *http.Request) {
 		return
 	}
 	q := r.URL.Query()
+	p, err := usageapi.PeriodOf(q.Get("period"))
+	if err != nil {
+		writeError(w, provider.Chat, http.StatusBadRequest, err.Error())
+		return
+	}
 	offset, _ := strconv.Atoi(q.Get("offset"))
 	limit, _ := strconv.Atoi(q.Get("limit"))
 	f := usageapi.FilterOf(q)
 	who := access.Caller(r.Context())
 	if !heldKey(who) {
-		writeJSON(w, 200, withoutClientIPs(usageapi.LedgerPage(usageapi.PeriodOf(q.Get("period")), f, offset, limit)))
+		writeJSON(w, 200, withoutClientIPs(usageapi.LedgerPage(p, f, offset, limit)))
 		return
 	}
 	f.CallerKey = who.KeyID
-	writeJSON(w, 200, withoutClientIPs(usageapi.OwnPage(usageapi.LedgerPage(usageapi.PeriodOf(q.Get("period")), f, offset, limit), who.KeyID)))
+	writeJSON(w, 200, withoutClientIPs(usageapi.OwnPage(usageapi.LedgerPage(p, f, offset, limit), who.KeyID)))
 }
diff --git a/internal/gateway/usage_period_test.go b/internal/gateway/usage_period_test.go
new file mode 100644
index 000000000..ec7010d18
--- /dev/null
+++ b/internal/gateway/usage_period_test.go
@@ -0,0 +1,42 @@
+package gateway
+
+import (
+	"net/http"
+	"net/http/httptest"
+	"strings"
+	"testing"
+)
+
+// An unparseable ?period= is refused, not silently answered with another
+// period's data (#5985): a caller asking for a period magpie doesn't know
+// (reference.md named week and month, which the HTTP layer never took) is
+// told so, and with the shapes that work. No period at all keeps the
+// default month it has always answered.
+func TestUsagePeriodUnknownIsRefused(t *testing.T) {
+	fresh(t)
+	t.Setenv("MAGPIE_ADDR", "")
+	h := lanGuard(New().Handler())
+	do := func(path string) (int, string) {
+		r := httptest.NewRequest("GET", path, nil)
+		r.RemoteAddr = "127.0.0.1:5000"
+		w := httptest.NewRecorder()
+		h.ServeHTTP(w, r)
+		return w.Code, w.Body.String()
+	}
+	for _, p := range []string{"week", "month", "1d", "24h", "bogus", "2026-11-08..2026-11-09..2026-11-10", "last:0"} {
+		if c, b := do("/v1/magpie/usage?period=" + p); c != http.StatusBadRequest || !strings.Contains(b, "period") {
+			t.Fatalf("GET /v1/magpie/usage?period=%s: %d %s, want 400 naming the period", p, c, b)
+		}
+		if c, _ := do("/v1/magpie/usage/requests?period=" + p); c != http.StatusBadRequest {
+			t.Fatalf("GET /v1/magpie/usage/requests?period=%s: %d, want 400", p, c)
+		}
+	}
+	if _, b := do("/v1/magpie/usage?period=week"); !strings.Contains(b, "today|7d|30d|all") {
+		t.Fatalf("the refusal names the shapes that work: %s", b)
+	}
+	for _, q := range []string{"", "period=", "period=today", "period=7d", "period=30d", "period=all", "period=last:24h", "period=2026-11-08..2026-11-09"} {
+		if c, b := do("/v1/magpie/usage?" + q); c != http.StatusOK {
+			t.Fatalf("GET /v1/magpie/usage?%s: %d %s, want 200", q, c, b)
+		}
+	}
+}
diff --git a/internal/gui/usage.go b/internal/gui/usage.go
index 6e84a5741..a09366c52 100644
--- a/internal/gui/usage.go
+++ b/internal/gui/usage.go
@@ -103,7 +103,12 @@ func requestContent(agent, session string, from, to, at time.Time) contentJSON {
 func usageRoutes(mux *http.ServeMux, w Windows) {
 	mux.HandleFunc("GET /api/usage", coldTurn(func(rw http.ResponseWriter, r *http.Request) {
 		// the days and hours of the reader's zone, which the page names
-		writeJSON(rw, usageState(periodOf(r.URL.Query().Get("period")), usageapi.ZoneOf(r)))
+		p, err := periodOf(r.URL.Query().Get("period"))
+		if err != nil {
+			fail(rw, err)
+			return
+		}
+		writeJSON(rw, usageState(p, usageapi.ZoneOf(r)))
 	}))
 	// the providers a deleted one's calls can be merged into: those there
 	// are now and shown, by name
@@ -181,9 +186,14 @@ func usageRoutes(mux *http.ServeMux, w Windows) {
 	// the ledger: the period's calls, newest first, a page at a time
 	mux.HandleFunc("GET /api/usage/requests", coldTurn(func(rw http.ResponseWriter, r *http.Request) {
 		q := r.URL.Query()
+		p, err := periodOf(q.Get("period"))
+		if err != nil {
+			fail(rw, err)
+			return
+		}
 		offset, _ := strconv.Atoi(q.Get("offset"))
 		limit, _ := strconv.Atoi(q.Get("limit"))
-		writeJSON(rw, ledgerPage(periodOf(q.Get("period")), ledgerFilter(r), offset, limit))
+		writeJSON(rw, ledgerPage(p, ledgerFilter(r), offset, limit))
 	}))
 	// the gateway's bytes up and down so far and its requests in flight,
 	// which the Requests read a moment apart for how fast its traffic flows
@@ -218,7 +228,11 @@ func usageRoutes(mux *http.ServeMux, w Windows) {
 	// the same CSV to a browser (magpie web), which saves it itself
 	mux.HandleFunc("GET /api/usage/requests.csv", func(rw http.ResponseWriter, r *http.Request) {
 		q := r.URL.Query()
-		p := periodOf(q.Get("period"))
+		p, err := periodOf(q.Get("period"))
+		if err != nil {
+			fail(rw, err)
+			return
+		}
 		// one moment for the rows and the day in the file's name, the
 		// reader's day
 		f := ledgerFilter(r)
@@ -231,7 +245,11 @@ func usageRoutes(mux *http.ServeMux, w Windows) {
 	// the rows the ledger shows, all its pages, as a CSV in Downloads
 	mux.HandleFunc("POST /api/usage/requests/export", func(rw http.ResponseWriter, r *http.Request) {
 		q := r.URL.Query()
-		p := periodOf(q.Get("period"))
+		p, err := periodOf(q.Get("period"))
+		if err != nil {
+			fail(rw, err)
+			return
+		}
 		f := ledgerFilter(r)
 		now := usage.Clock().In(f.Zone)
 		rows := usage.LedgerOfAt(p, f, now).Rows
diff --git a/internal/gui/usage_period_api_test.go b/internal/gui/usage_period_api_test.go
new file mode 100644
index 000000000..d9034ae91
--- /dev/null
+++ b/internal/gui/usage_period_api_test.go
@@ -0,0 +1,35 @@
+package gui
+
+import (
+	"net/http"
+	"net/http/httptest"
+	"testing"
+)
+
+// The GUI's usage routes refuse an unparseable ?period= the same way the
+// gateway's do (#5985): a value no period parses to is a 400 that names
+// the shapes that work, not another period's data. No period keeps the
+// default month.
+func TestUsagePeriodUnknownRefusedAPI(t *testing.T) {
+	sandboxHome(t)
+	mux := http.NewServeMux()
+	usageRoutes(mux, folderOnly{})
+	get := func(path string) (int, string) {
+		w := httptest.NewRecorder()
+		mux.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
+		return w.Code, w.Body.String()
+	}
+	for _, p := range []string{"week", "month", "bogus"} {
+		if c, b := get("/api/usage?period=" + p); c != http.StatusBadRequest {
+			t.Fatalf("GET /api/usage?period=%s: %d %s, want 400", p, c, b)
+		}
+		if c, b := get("/api/usage/requests?period=" + p); c != http.StatusBadRequest {
+			t.Fatalf("GET /api/usage/requests?period=%s: %d %s, want 400", p, c, b)
+		}
+	}
+	for _, q := range []string{"", "period=today", "period=7d", "period=30d", "period=all", "period=last:24h", "period=2026-11-08..2026-11-09"} {
+		if c, b := get("/api/usage?" + q); c != http.StatusOK {
+			t.Fatalf("GET /api/usage?%s: %d %s, want 200", q, c, b)
+		}
+	}
+}
diff --git a/internal/usageapi/period_of_test.go b/internal/usageapi/period_of_test.go
new file mode 100644
index 000000000..142baafd6
--- /dev/null
+++ b/internal/usageapi/period_of_test.go
@@ -0,0 +1,45 @@
+package usageapi
+
+import (
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/usage"
+)
+
+// PeriodOf takes a period a ?period= names, and refuses what no period
+// parses to (#5985): no value at all keeps the default month, a known
+// one is itself, and anything else — including reference.md's week and
+// month, which the HTTP layer never took — is an error naming the shapes
+// that work, never another period's data.
+func TestPeriodOfKnownOrError(t *testing.T) {
+	for _, in := range []struct {
+		s    string
+		want usage.Period
+	}{
+		{"", usage.Month},
+		{"today", usage.Today},
+		{"7d", usage.Week},
+		{"30d", usage.Month},
+		{"all", usage.All},
+		{"last:24h", "last:24h"},
+		{"2026-11-08..2026-11-09", "2026-11-08..2026-11-09"},
+	} {
+		p, err := PeriodOf(in.s)
+		if err != nil {
+			t.Fatalf("PeriodOf(%q): %v", in.s, err)
+		}
+		if p != in.want {
+			t.Fatalf("PeriodOf(%q) = %q, want %q", in.s, p, in.want)
+		}
+	}
+	for _, s := range []string{"week", "month", "1d", "24h", "bogus", "2026-11-08..2026-11-09..2026-11-10", "last:0"} {
+		p, err := PeriodOf(s)
+		if err == nil {
+			t.Fatalf("PeriodOf(%q) = %q with no error, want one", s, p)
+		}
+		if !strings.Contains(err.Error(), "today|7d|30d|all") {
+			t.Fatalf("PeriodOf(%q)'s error names no working shape: %v", s, err)
+		}
+	}
+}
diff --git a/internal/usageapi/usageapi.go b/internal/usageapi/usageapi.go
index 7038d177a..4fa293bda 100644
--- a/internal/usageapi/usageapi.go
+++ b/internal/usageapi/usageapi.go
@@ -6,6 +6,7 @@ package usageapi
 
 import (
 	"cmp"
+	"fmt"
 	"net/http"
 	"net/url"
 	"os"
@@ -216,12 +217,20 @@ func inKeyOrder(groups []Group) []Group {
 }
 
 // PeriodOf is the period a ?period= names: a preset, or days picked as
-// "2026-10-01..2026-10-07" (#1492); 30 days for anything else.
-func PeriodOf(s string) usage.Period {
+// "2026-10-01..2026-10-07" (#1492). No value at all is the month it has
+// always defaulted to. Anything else that no period parses to is an error:
+// a caller asking for a period magpie doesn't know must not be silently
+// answered with another period's data (#5985) — reference.md once named
+// week and month, which the HTTP layer never took, and an app asking for
+// one of those was told 30 days as if it had asked for them.
+func PeriodOf(s string) (usage.Period, error) {
 	if p := usage.Period(s); p.Known() {
-		return p
+		return p, nil
 	}
-	return usage.Month
+	if s == "" {
+		return usage.Month, nil
+	}
+	return "", fmt.Errorf("unknown period %q: want today|7d|30d|all, a from..to day range like 2026-11-08..2026-11-09, or last:<duration>", s)
 }
 
 // FilterOf is the filter a request's query names. A found routing group's
-- 
2.50.1 (Apple Git-155)
```

</details>
