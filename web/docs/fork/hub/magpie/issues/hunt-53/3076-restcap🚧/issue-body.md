**Summary**

binbinah reported (with production data) that `magpie provider rest-cap <id>` is silently dead for subscription-account providers such as `codex`. On v0.1.1236: `magpie provider rest-cap codex 1m` writes `"restCap": 1` into providers.json, but right after the write the command's own echo still says *"a key or account that keeps failing sits out at most 10 minutes, 30 when rate limited (magpie's own)"*, and `GET /api/providers` shows no `restCap` for `codex`. Every Codex account keeps the built-in 1 → 2 → 4 … 10-minute ladder after a 529, and under sustained vendor overload the ladder benches most of their pool (at peak, a median of 15–18 of 20 accounts resting; see the issue for the full routing-data breakdown).

**Cause**

One missing copy in the read path. `SetRestCap` (internal/provider/concurrency.go:352) goes Find → set → Save, and Save's account copy (internal/provider/provider.go:807) keeps `QuotaRest`, `QuotaResetAt` and `RestCap` — the write side is fine. But the providers the gateway routes with are rebuilt by `withPicks` (internal/provider/provider.go:675), which lays the user's picks from providers.json over every signed-in account and copies `AccountConcurrency`, `QueueLimit`, `QueueWait`, `MaxRPM`, routing, models and others — not the three rest fields. `restAfterMarked` (internal/gateway/routing.go:813) then reads the merged candidate provider: `OwnQuotaRest` at :860, `NoFailRest` at :905, `RestCapOr` at :930 and :1051 — all read 0, so the cap is always the gateway's own. The same merged provider is what the CLI echo (`restCapCmd`, internal/cli/providers_cli.go:1696) and `GET /api/providers` serve, which is exactly the reporter's two phenomena; the editor's save (internal/gui/providers.go:1503) reads it too, so re-saving a subscription account in the GUI would even overwrite the stored cap with 0.

This is an oversight, not intent: `withPicks` was introduced by 5e5b6a5a (2026-10-13, #1899), one day *before* `RestCap` existed (bf258427, 2026-10-14, #2008). #2008's message says the setting "is kept by the editor's save, the account copy and normalize" — all write-side — and the read-side overlay was missed. Later provider settings did get added to `withPicks` one by one (`ExtraBody`, dd25997a, 2026-10-15); `RestCap` never was. `QuotaRest`/`QuotaResetAt` predate `withPicks` and were missed the same way, so `magpie provider quota-rest` is equally dead for subscription accounts; the same line heals it.

**Fix**

One line in `withPicks` copying the three fields, matching the save-side account copy's whitelist:

```go
a.QuotaRest, a.QuotaResetAt, a.RestCap = pk.QuotaRest, pk.QuotaResetAt, pk.RestCap
```

Both `withPicks` call sites (`allProviders`, internal/provider/provider.go:657, and `AlsoOn`, internal/provider/logins_on.go:124) go through it, so every account of the provider gets the setting. Unset (`0`) an account rests as the gateway always did; `off` (`RestCapOff`, -1) still means no rest at all after a failure that says nothing of why. The issue's asks 2 (per-provider max-tries) and 3 (529 handling) are untouched — left to the maintainers.

**Verification**

| Check | Command | Result |
|---|---|---|
| New tests, fix in | `go test ./internal/provider -run 'TestWithPicksKeepsTheRest\|TestRestCapReachesTheAccount' -count=1 -v` | `ok` — both PASS |
| Full provider package | `go test ./internal/provider/... -count=1 -timeout 20m` | `ok ... 80.552s` |
| Gateway consumer side | `go test ./internal/gateway -run 'Rest\|rest' -count=1` | `ok ... 5.024s` |
| Race, new tests | `go test -race ./internal/provider -run 'TestWithPicksKeepsTheRest\|TestRestCapReachesTheAccount' -count=1` | `ok ... 2.070s` |
| gofmt | `gofmt -l` on the two changed files | empty |
| vet | `go vet ./internal/provider` | clean |
| Build darwin/arm64 | `GOOS=darwin GOARCH=arm64 go build ./...` | ok |
| Build windows/amd64 | `GOOS=windows GOARCH=amd64 go build ./...` | ok |
| Build linux/amd64 | `GOOS=linux GOARCH=amd64 go build -tags nogui ./...` (the Makefile's cross-compile path) | ok |
| Build linux/amd64, plain | `GOOS=linux GOARCH=amd64 go build ./...` | fails inside wails's own `webview_window_linux.go` (module cache) — preexisting, untouched by this change; `./internal/provider` and `./internal/gateway` build clean on linux |
| Ablation | `internal/provider/provider.go` reverted to base, new tests kept, same targeted `go test` | both tests FAIL (text below) |
| Break by hand | the new copy commented out, same targeted `go test` | both tests FAIL; restored, `ok` |
| Write/read round-trip | `SetRestCap` 240 / off / 0, each read back via `Find` | 240 / `NoFailRest` / 0 — the negative cases in `TestRestCapReachesTheAccount` |

**Not verified**

A real Codex subscription account (the tests sign in a fake Codex account), the Docker deployment the reporter used, and a recomputation against their production routing data. Ask 2 and ask 3 unaddressed.

---
**Source**: reported in #3076 (binbinah, with production data); patch found by code audit (AI-assisted) and verified with a unit test.

**Red without the fix** (base `318697dc`): with `internal/provider/provider.go` reverted and the new test kept, `go test ./internal/provider -run 'TestWithPicksKeepsTheRest|TestRestCapReachesTheAccount'` fails:
```
=== RUN   TestWithPicksKeepsTheRest
    rest_cap_test.go:16: an account of the provider keeps its rests: quota rest 0, reset at "", rest cap 0, want 90, "08:00", 240
--- FAIL: TestWithPicksKeepsTheRest (0.00s)
=== RUN   TestRestCapReachesTheAccount
    rest_cap_test.go:49: a rest cap set on codex reads back 0, want 240
--- FAIL: TestRestCapReachesTheAccount (0.05s)
FAIL
FAIL	github.com/yetone/magpie/internal/provider	0.998s
```
With the fix: `ok`.

**Siblings**: `rg -n 'withPicks\(' internal/` — the definition plus two calls (provider.go:657, logins_on.go:124), both covered by the one fixed function. `rg -n 'RestCap|QuotaRest|QuotaResetAt' internal/` (non-test) — the save-side account copy provider.go:807 already copies all three (no change); the normalize clamp provider.go:1300-1305 (no change); the setters `SetRestCap`/`SetQuotaRest`/`SetQuotaResetAt` write via Find→Save and were already kept (no change); the gateway reads routing.go:860/905/930/1051 consume the merged provider and need no change; the CLI echo (providers_cli.go:1696) and the GUI's keep-old logic (gui/providers.go:1525-1536) also read the merged provider — the GUI overwrite of a stored cap was the same root cause and heals with the same line. No third construction site found.

**When the read fails**: with nothing set (`RestCap` 0) the merged account returns `RestCapOr(def)` = the gateway's own ladder and `NoFailRest()` = false, i.e. today's behavior unchanged; `off` (-1) survives save, normalize and the copy and still means no rest after an unnamed failure — both guarded by the negative cases in the new tests.

**Not verified**: a real Codex subscription account, the Docker deployment, the reporter's production-data recomputation, and the GUI editor flow by hand.

Branch with the commit: [hunt53-d-restcap](https://github.com/ggbdpq/magpie/tree/hunt53-d-restcap) (head `048abe41`).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: provider: a provider's rest-cap and quota rest reach its signed-in accounts (#3076) — git am applies it as is; SHA-256 first 16: 1ef110ada14b45cb</summary>

```patch
From 048abe41e520c18823f8fda20270b12767d64abb Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 20 Oct 2026 22:57:32 +0800
Subject: [PATCH] provider: a provider's rest-cap and quota rest reach its
 signed-in accounts (#3076)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

`magpie provider rest-cap <id>` (and quota-rest) on a provider the agent
is signed in to, codex and friends, was written to providers.json and
never reached the accounts the gateway routes with: withPicks lays the
user's picks over every signed-in account and copied the queue, the
limits and the models, not the rests. The save kept the rests (the
account copy in Save carries the three fields), the read dropped them,
so every Codex account kept the gateway's own 10/30-minute ladder after
a 529 and sat out most of the reporter's pool at peak. The command's own
echo, GET /api/providers and the editor's save (whose old provider comes
from Find) all read the merged provider, which had none.

withPicks now carries QuotaRest, QuotaResetAt and RestCap with the rest
of the picks. Unset, an account rests as the gateway always did;
RestCapOff still means no rest at all after a failure that says nothing
of why. The same copy covers AlsoOn, which goes through withPicks too.

Fixes #3076

Run (worktree at 318697dcea4e): go test ./internal/provider -run
'TestWithPicksKeepsTheRest|TestRestCapReachesTheAccount' -count=1 -v —
two new tests, both fail on the base and pass here; go test
./internal/provider/... -count=1 — ok, 80s; go test ./internal/gateway
-run 'Rest|rest' -count=1 — ok; go test -race on the two new tests —
ok; gofmt -l clean; go vet ./internal/provider clean; go build ./... on
darwin/arm64 and windows/amd64, and on linux/amd64 with -tags nogui (the
Makefile's cross-compile path; a plain ./... there fails in wails's own
webview_window_linux.go, which this change doesn't touch).

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/provider.go      |  4 ++
 internal/provider/rest_cap_test.go | 63 ++++++++++++++++++++++++++++++
 2 files changed, 67 insertions(+)
 create mode 100644 internal/provider/rest_cap_test.go

diff --git a/internal/provider/provider.go b/internal/provider/provider.go
index 6e8a7bee..4669e8a2 100644
--- a/internal/provider/provider.go
+++ b/internal/provider/provider.go
@@ -684,6 +684,10 @@ func withPicks(a, pk Provider) Provider {
 	a.MaxConcurrency, a.PinUpstream = pk.MaxConcurrency, pk.PinUpstream
 	a.AccountConcurrency, a.QueueLimit, a.QueueWait = pk.AccountConcurrency, pk.QueueLimit, pk.QueueWait
 	a.MaxRPM = pk.MaxRPM
+	// and how long its keys and accounts sit out of quota and while they
+	// keep failing, or that they don't at all (#3076: a rest-cap set on a
+	// provider the agent is signed in to never reached its accounts)
+	a.QuotaRest, a.QuotaResetAt, a.RestCap = pk.QuotaRest, pk.QuotaResetAt, pk.RestCap
 	// the extra body fields written for it, which a ChatGPT account's
 	// requests take (WithExtraBody, magpie-releases#18)
 	a.ExtraBody = pk.ExtraBody
diff --git a/internal/provider/rest_cap_test.go b/internal/provider/rest_cap_test.go
new file mode 100644
index 00000000..0c9ee03f
--- /dev/null
+++ b/internal/provider/rest_cap_test.go
@@ -0,0 +1,63 @@
+package provider
+
+import "testing"
+
+// #3076 (binbinah): the rests a user sets on a provider the agent is
+// signed in to (codex and friends) never reached the accounts the gateway
+// routes with. withPicks lays the user's picks from providers.json over
+// every signed-in account and copied the queue, the limits and the models,
+// not the rests: a `magpie provider rest-cap codex 4h` was written to
+// providers.json and read back as nothing, so every Codex account kept
+// the gateway's own 10/30-minute ladder after a 529.
+func TestWithPicksKeepsTheRest(t *testing.T) {
+	pk := Provider{ID: "codex", QuotaRest: 90, QuotaResetAt: "08:00", RestCap: 240}
+	a := withPicks(Provider{ID: "codex"}, pk)
+	if a.QuotaRest != 90 || a.QuotaResetAt != "08:00" || a.RestCap != 240 {
+		t.Fatalf("an account of the provider keeps its rests: quota rest %d, reset at %q, rest cap %d, want 90, \"08:00\", 240", a.QuotaRest, a.QuotaResetAt, a.RestCap)
+	}
+	// off is off: no rest at all after a failure that says nothing of why,
+	// not the gateway's own ladder
+	a = withPicks(Provider{ID: "codex"}, Provider{ID: "codex", RestCap: RestCapOff})
+	if a.RestCap != RestCapOff || !a.NoFailRest() {
+		t.Fatalf("an account of a provider set off: rest cap %d (NoFailRest %v), want %d", a.RestCap, a.NoFailRest(), RestCapOff)
+	}
+	// and nothing set carries nothing: the picks stand over what the
+	// account had, as they do over the rest of the overlay
+	a = withPicks(Provider{ID: "codex", RestCap: 5, QuotaRest: 15}, Provider{ID: "codex"})
+	if a.RestCap != 0 || a.QuotaRest != 0 || a.QuotaResetAt != "" {
+		t.Fatalf("an account of a provider with no rests set: %d, %d, %q, want the gateway's own zeroes", a.RestCap, a.QuotaRest, a.QuotaResetAt)
+	}
+}
+
+// The way the reporter saw it: the cap is written (`SetRestCap`, as
+// `magpie provider rest-cap` does) and read back (`Find`, as the command's
+// echo and GET /api/providers both do) on a signed-in account.
+func TestRestCapReachesTheAccount(t *testing.T) {
+	signIn(t)
+	rememberLogins(true)
+	if _, err := Find("codex"); err != nil {
+		t.Fatalf("codex signed in: %v", err)
+	}
+	if err := SetRestCap("codex", 240); err != nil {
+		t.Fatal(err)
+	}
+	p, err := Find("codex")
+	if err != nil {
+		t.Fatal(err)
+	}
+	if p.RestCap != 240 {
+		t.Fatalf("a rest cap set on codex reads back %d, want 240", p.RestCap)
+	}
+	if err := SetRestCap("codex", RestCapOff); err != nil {
+		t.Fatal(err)
+	}
+	if p, err = Find("codex"); err != nil || !p.NoFailRest() {
+		t.Fatalf("rest-cap off reads back %+v %v, want NoFailRest", p, err)
+	}
+	if err := SetRestCap("codex", 0); err != nil {
+		t.Fatal(err)
+	}
+	if p, err = Find("codex"); err != nil || p.RestCap != 0 || p.NoFailRest() {
+		t.Fatalf("the gateway's own reads back %+v %v, want rest cap 0", p, err)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>
