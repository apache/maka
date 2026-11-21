Refresh of my rework above (the one built per your review — "it doesn't reach the reporter's case"), not a redesign: the same commit rebased onto current `upstream/main` (`4b29709ec`) with four conflicts resolved, and the whole verification re-run. What upstream added since and how the union went:

- `trace.go`: main's `UseFirst` row flag and this patch's `Keeps` flag now sit beside each other; a row can say both.
- `gui/providers.go` + `provider.go`: main's `UseFirst`/`NoStandIn` keep-lines and this patch's `KeepThroughRest` keep-line are all three carried.
- `docs/subsystems/gateway-routing.md`: main's `restLast` bullet (which has since gained the vendor-timed holds, `timedHeld`/`vendorTimed`) stays as main has it; the patch's *Keep through a rest* bullet follows it as its own bullet.
- `affinity.go`: main added an `hoursOver` argument to `affine` since — the rebased test calls carry it; the seat-keeping itself (`Keeps` marking in `restLast`, `affine`'s `keep` why, `seatKept` guarding the stick write and the mid-reply break-off) merged unchanged, and the production files auto-merged with one duplicated comment line fixed by hand.

The mechanics, as the rework defined them, verified on the current tree: `restLast` marks a keeping candidate's row `Keeps` and holds it back as any resting one (a ready one answers, nothing is asked to death); `affine` says `keep` for a seat resting out of a rate limit or a why-less failure and keeps the conversation on it; the ready one's answer doesn't take the conversation over; once the rest is over the next turn goes back to the account that has the cache. Quota, credit, restricted and verify rests still move it, as does every rest of a pool without the setting.

<details><summary>patch: gateway: a pool keeps its conversation through a short rest — git am applies it as is; SHA-256 first 16: 69d366ae622bec37</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 6 Nov 2026 21:24:26 +0800
Subject: [PATCH] gateway: a pool keeps its conversation through a short rest
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

rework per yetone's review of the first patch (#4030): keeping the
routing order didn't reach the reporter's case, which goes through
affine first, and asked the resting account again on every request.

A pool set KeepThroughRest now holds its conversation, not the order.
restLast marks the resting candidate Keeps and holds it back as any
resting one (a ready one answers, nothing is asked to death); affine
says "keep" for a seat resting out of a rate limit or a why-less
failure and keeps the conversation on it without taking the request's
front, and the ready one's answer doesn't take the conversation over
(seatKept, at the ask and at a mid-reply break-off) — once the rest is
over the next turn goes back to the account that has the cache. A rest
out of quota or credit still moves it, and so does every rest of a
pool without the setting.

The first patch's restLast branch that let a keeping candidate keep
its routing place is gone: keeping the place was what asked the
resting account again on every request.

Tests: restLast marks Keeps (and doesn't, on quota, credit, and
without the setting); affine holds the seat through a rest and leaves
the ready one in front; end to end, two turns of one conversation with
the second refused by a short 429 and answered by the other key, a
turn in between on the ready key, and the turn after the rest back on
the key that has the cache — a pool without the setting moves it for
good.

Fixes #4030
Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/gateway-routing.md         |   3 +
 internal/cli/pool_cli.go                   |  23 ++-
 internal/cli/pool_keep_cli_test.go         |  59 +++++++
 internal/gateway/affinity.go               |  33 ++++
 internal/gateway/fallback.go               |  22 ++-
 internal/gateway/gateway.go                |  14 +-
 internal/gateway/pool_keep_affine_test.go  | 184 +++++++++++++++++++++
 internal/gateway/pool_keep_test.go         |  92 +++++++++++
 internal/gateway/trace.go                  |   7 +-
 internal/gui/providers.go                  |   1 +
 internal/provider/account_settings_test.go |   9 +-
 internal/provider/provider.go              |  12 ++
 internal/provider/routing.go               |  12 ++
 13 files changed, 459 insertions(+), 12 deletions(-)
 create mode 100644 internal/cli/pool_keep_cli_test.go
 create mode 100644 internal/gateway/pool_keep_affine_test.go
 create mode 100644 internal/gateway/pool_keep_test.go

diff --git a/docs/subsystems/gateway-routing.md b/docs/subsystems/gateway-routing.md
index 348734b83..1f11f2f0b 100644
--- a/docs/subsystems/gateway-routing.md
+++ b/docs/subsystems/gateway-routing.md
@@ -254,6 +254,9 @@ recorded as a prediction failure (`noPrediction`).
 - A turn's end is told to the app for the "Task done alert" notification (itieniu on X, `turndone.go`). The trace follows each agent session's turn (`turns`, keyed by agent and session): a request is of the turn unless it has a `Kind` or is a Claude Code subagent's (`agentTurnOf`), and its reply is scanned on the way to the agent for a tool call in any wire format (`toolScan`, a JSON value such as `"type":"tool_use"` or `"finish_reason":"tool_calls"`, never a key or text). The turn is done when no request of it is going, the last reply was whole, under 400 and called no tool, and nothing more came for `turnQuiet` (4s); a session idle past `turnStale` (30m) starts over. Only a turn that ran at least `settings.TurnDoneAlert` seconds is told (`TurnDone`, set by the GUI; nil under `magpie serve`, so nothing is followed). The ChatGPT backend path (`codexBackend`) is followed the same way. `TestTurnDoneSaidAtTheTurnsEnd`, `TestTurnDoneCodexBackend`, `TestToolScan`, `turn-done.test.cjs`.
 - A request's masking record is told to the app for the "Masking alert" notification (Must2333 on X, `OnMasked` in [`masked.go`](../../internal/gateway/masked.go), set by the GUI; nil under `magpie serve`), after `maskrec.Hold` and with its text around placeholders (`Snips`, `Back`) taken out. [`mask_alert.go`](../../internal/gui/mask_alert.go) keeps the records while `settings.MaskAlert` is on (off until turned on, in Settings → Usage, hidden with masking) and says only the values a record masked for the first time (`maskrec.Fresh`, [`first.go`](../../internal/maskrec/first.go): each placeholder by the key of the first record that had it, read from memory and the days kept, so a conversation's history sent again each turn, or after a restart, is not news; a value sent as written is not one masked). A burst is gathered for `maskGather` (3s) and said as one, and one is said at most every `maskGap` (1 minute), what came in between said after it. It says each kind with its count and up to two agents, never a value nor its hint; a click opens the Masking page on the latest record (`clickView`, `masking&key=`). A held-back request (`noteBlocked`) is not said; a value whose records have all aged out (30 days) is new again. `TestFreshOnlyTheFirstTime`, `TestMaskAlertFirstTimeOnly`, `TestMaskAlertNeverSaysTheValue`, `TestMaskAlertCoalesces`, `mask-alert.test.cjs`.
 - A resting candidate is tried last (`restLast`). Of the resting candidates, a request asks only the one whose rest ends soonest, the first in order on a tie (`probeOne`, #1799). The others aren't asked by that request, so a member that is down isn't asked by every request its rest was meant to spare it from, and a group that is down whole takes one upstream request per request, not one per member. Every ready candidate is still asked in its order. A lone candidate is tried even while it rests, because there is no other. The trace still lists every member, the resting ones with their rest. Only rests are read, and a failure about the request's content or its model rests no member (a model refusal rests only `restID`), so neither leaves a member out. The same applies in `count_tokens`, embeddings and rerank, image accounts and a group's System One decision models. A Codex reset (`autoReset`) still looks over every candidate. This is like AxonHub's error-aware load balancing: the rest and its backoff are the penalty that decays, and the member back soonest is the one asked to show it is back. Keys out of their allowance aren't asked even so, not even the one back soonest or a lone one (#1772: four Ollama Cloud keys out for the week, each asked again and refused on every request). The refusal given again says when they are asked again on this magpie's clock with its offset (`heldClock`: "20:12 UTC+8", "Oct 16 09:00 UTC+8"), as do the gateway's other held errors (a capped window, a spent searcher or describer): its reader may be a Remote magpie's user on another clock. When every candidate left is a key (not a subscription account, whose resets `autoReset` may spend) resting out of quota or credit after a 429 or 402, none is asked. The first one's refusal is given again (`quotaHeld`, its words kept in the rest's `said`), saying when it is asked again. A key whose rest magpie guessed the length of, the vendor and the user naming no time (`creditRest`, or `quotaRest` with no `Provider.OwnQuotaRest`), is held so only once it was refused so twice in a row (`Rest.first`): a single refusal may be a moment's, and the next request, the agent's retry first, asks it again (zoecats on Discord: a local aggregator said 429 `insufficient_quota` "quota exhausted" for the moment it switched upstreams, and every request was answered from its rest of 15 or 30 minutes, which only the provider's "Rests" switch, `LimitRestOff`, let through before). Held, it is asked again a minute on (`Rest.askAt`, `fallbackCooldown`), once, and held again if refused (`Rest.asksAt`); a time the vendor named, or the user set, holds it from the first refusal to then. The rest itself stays as long as before, so the order still passes it over for a candidate that is ready. The last key left rests too when it is refused so, as the keys before it do, and so does the last account left (a Codex or other subscription account; `quotaHeld` still holds keys alone, and `autoReset` lifts the rest of an account it spends a reset of): before, an account last in an in-order group, out of its quota, was never rested, so every request a relay ahead of it failed for a moment went on to it and ended on its 429 (dbydd on Discord; `TestGroupSpentLastAccountRests`). Any 429 that reaches the agent without a vendor `Retry-After`, while every candidate tried is resting, carries one: the seconds until the first of them is asked again (`soonestBack`, by `asksAt`), none after a key's first refusal. `TestRetryAfterALimitIsAsked`, `TestHeldLimitAskedAgainInAMinute`. A quota refusal with no word of when it is back rests `quotaRest` (15 minutes), or the provider's own `quotaRest` in minutes (`Provider.QuotaRestFor`, at most `MaxQuotaRest`, 8 days; `magpie provider quota-rest <id> 7d`), or until the time of day the user said its allowance comes back (`QuotaResetAt`, `Provider.OwnQuotaRest`; `magpie provider quota-rest <id> until 08:00`, or `until 00:00+08:00` on the vendor's clock; #2008, a free tier's "today's free-model token quota"). Whichever of the two was set last counts. A time the vendor names stands over it, and so does its `Retry-After`, unless that was more than `longestWait` (an hour) and so cut to it while the user's own rest is longer: then the user's stands (`TestQuotaRestsUntilTheTimeOfDaySet`). A key or an account resting on a 429 for the time its vendor named (`Rest.By` "retry-after" or "resets": a `Retry-After`, an `anthropic-ratelimit-*-reset` or `x-ratelimit-reset-*` header, or a refusal's `resets_in_seconds` / `resets_at`), rate limited or out of its allowance, is held the same way when every candidate left rests so (`timedHeld`, `vendorTimed`): none is asked, not even the soonest back or a lone one, and the agent is answered with the first one's error and a `Retry-After` until the first of them is back, set on the held answer too, so neither the same-one retry (`passing`) nor the patience's rounds take it for a moment's limit. Not a Codex account that spends its resets by itself (`autoReset`), nor another computer's model (`Rest.there`), nor a provider with `LimitRestOff`, which never rests for a limit. The last one left rests on such a 429 too (`vendorSaidWhen`); one naming no time rests nobody, as before. Before, a key or account limited for 300 seconds was asked again every time the agent retried, about every half a second, until the vendor flagged the accounts (hsjzg58958 on X). Codex's own sign-in, and the account a compaction goes to, are relayed outside the candidate loop (`codexUpstreamOn`): a 429 there that names its time holds that account in `codexHolds` (`noteCodexHold`), and Codex's retries are answered with ChatGPT's own refusal and a `Retry-After` till then (`writeCodexHeld`), unless the turn has fallbacks or groups to go on to (`codexFallsBack`), which take it as they took the turn that held the account (`TestCodexHeldTurnFollowsTheGroup`); a reset spent or a window started again lifts a hold out of allowance (`restarted`). Codex's API key isn't held: OpenAI's platform answers it. `TestRateLimitedKeysHeldUntilTheirReset`, `TestRateLimitedCodexAccountsHeldUntilTheirReset`. A key listed in `keys` as well as in `key` is one candidate (`KeysOn`), not asked twice. `TestAllRestingAnswersFromRest`, `TestOwnQuotaRest`, `TestQuotaHeldOnlyForKeysOutOfAllowance`, `TestFirstKeyListedTwiceAskedOnce`.
+
+- A pool whose provider says *Keep through a rest* (`Provider.KeepThroughRest`, `magpie provider pool <id> --keep on`; wssz527, #4030) keeps its resting key or account in the place the routing gave it when the rest is a rate limit or a failure that says nothing of why — the transient kinds, over in seconds — for what the vendor cached of the conversations it answers is worth more than the wait: a conversation moved pays its whole prompt again on the next account. A rest out of quota or credit, a restricted account, and one asked to verify itself still move it, and so does every rest of a provider without the setting. Its trace row still says it rests, so a new conversation goes to a ready one (`readyForNew`), and the Routing page says what happened. `pool_keep_test.go`.
+
 - A model its plugin reports busier than the user's *Busy models last* (`settings.BusyLoad`, 1 to 9999 (`BusyLoadMost`-1), past 100 for a vendor that queues, its Custom… field taking any of them, off by default; axelburks on Discord) goes behind the ready candidates, ahead of the resting ones (`restLast`, `busyOf`), and its trace row has `busy` with the load. The load comes from the plugin through `plugin.ModelLoad` (see [provider plugins](provider-plugins.md#a-models-load)); one not reported in the last 5 minutes is unknown and keeps its place. A lone candidate is asked whatever its load. A conversation it answered moves, at its next turn, to the ready one that leads (`affine`'s Why `busy`, `busyBehind`); within a turn it stays. A turn going round (`after`), a new conversation spread (`readyForNew`) or In turn (`leastHeld`) never lands on it past a ready one. When every candidate is busy, nothing moves.
 - A key resting after an outage that names no time is asked again in the background (`rest_probe.go`, heatonz on Discord). Behind ready keys, `probeOne` never asks it before its rest ends, though its vendor may be back in a minute. `restAfterMarked` marks the rest `Probed` when it is a key's own (not an account's or a plugin's, not one model's `restID`), `failOther` by `backoff` after a 5xx, a 408 or no connection, with no Retry-After or reset header, at a provider whose `List` asks over the network (`Provider.ListAsks`), and long enough for a first ask. `keepProbingRests`, started in `ListenAndServe`, then asks the vendor's model list with that key through its proxy (`Provider.List`, which saves nothing) 1, 2, 5 and then every 10 minutes into the rest, while it is the same rest. When the list answers, the rest is lifted as Try now lifts it (`liftedLocked`, `unsink`, the trace's lift). Not asked: rate limits (a list answers while the chat endpoint still refuses, and lifting one early would undo Sink), quota, credit, a Retry-After or reset, a refused key (401, 403, 400), restrictions and verification, each of which ends on its own time or the vendor's. A key a probe lifted that fails again within 30 minutes isn't asked again until it answers a request (`probeMissed`, `probeAnswered` in `served`): the list answered for the vendor, not for its chat. Only the loop's own `Server` asks (`restProbes.asking`), so a test's `Server` never reaches the network. The cost is one list per resting key per step, never one per request. The key list (`KeyRest.Probed`) and Routing's words for the try (`restHow`) add "checked in the background, back as soon as it answers". `TestRestProbeLiftsAKeyBackUp`, `TestRestProbeLeavesOtherRests`, `TestRestProbeOnlyByARunningLoop`, `rest-probed.test.cjs`.
 - A provider whose keys are on different plans (`KeyAccount.Plan`, `PlansMixed`; yckonnnn on X) sends each key to its plan's endpoints: every key path takes its copy through `WithKey`, which moves it there (`atKeyPlan`), on the first try and on a failover alike. `perKeyBarred` leaves out a key whose plan's list lacks the model (`PlanServing`: a pay-as-you-go model id at the Agent Plan's endpoint only answers 404), not shown in the trace; only when no key's plan has it are those keys asked. Embeddings and drawing go through the same `perKeyBarred` and `WithKey`; a video started on a mixed provider names its key in the task id (`videoStart.onKey`, `keyMark`) so its poll goes to that key's plan. `TestKeyPlansEachToItsOwnEndpoint`.
diff --git a/internal/cli/pool_cli.go b/internal/cli/pool_cli.go
index 66c5f40c2..3feca83f0 100644
--- a/internal/cli/pool_cli.go
+++ b/internal/cli/pool_cli.go
@@ -15,7 +15,7 @@ import (
 	"github.com/yetone/magpie/internal/provider"
 )
 
-const poolUsage = "magpie provider pool <id> [--accounts a,b,…] [--cap percent|off] [--stop on|off] [--careful on|off]"
+const poolUsage = "magpie provider pool <id> [--accounts a,b,…] [--cap percent|off] [--stop on|off] [--careful on|off] [--keep on|off]"
 
 // poolCmd shows a subscription's pool, after setting what the flags say:
 // --accounts puts those accounts in use in that order, the rest out of
@@ -23,14 +23,17 @@ const poolUsage = "magpie provider pool <id> [--accounts a,b,…] [--cap percent
 // --stop answers 429 while every account is at its cap rather than going
 // on to the fallbacks (provider.Provider.CapStop); --careful reads usage
 // again near a cap and holds an account whose usage can't be told
-// (provider.Provider.CapCareful).
+// (provider.Provider.CapCareful); --keep keeps a request on the account
+// its conversation answered through a transient rest, a rate limit or a
+// failure, rather than pay its prompt again on another account
+// (provider.Provider.KeepThroughRest).
 func poolCmd(rest []string) error {
 	usage := fmt.Errorf("%s", poolUsage)
 	var id string
 	var accounts []string
 	accountsSet, capSet := false, false
 	capN := 0
-	var stop, careful *bool
+	var stop, careful, keep *bool
 	onOff := func(v string) (*bool, error) {
 		switch strings.ToLower(strings.TrimSpace(v)) {
 		case "on", "true", "yes":
@@ -80,6 +83,8 @@ func poolCmd(rest []string) error {
 			stop, err = onOff(val)
 		case "--careful":
 			careful, err = onOff(val)
+		case "--keep":
+			keep, err = onOff(val)
 		default:
 			return usage
 		}
@@ -175,7 +180,12 @@ func poolCmd(rest []string) error {
 			return err
 		}
 	}
-	if accountsSet || capSet || stop != nil || careful != nil {
+	if keep != nil {
+		if err := provider.SetKeepThroughRest(p.ID, *keep); err != nil {
+			return err
+		}
+	}
+	if accountsSet || capSet || stop != nil || careful != nil || keep != nil {
 		fmt.Println(green.Render("✓"), "saved", p.Name, muted.Render("("+p.ID+")"))
 		if p, err = provider.Find(p.ID); err != nil {
 			return err
@@ -238,8 +248,13 @@ func printPool(p provider.Provider, ls []provider.Login) {
 	if !p.CapCareful {
 		careful = "off: routing goes by the last reading, read again each minute"
 	}
+	keep := "off: a request whose account rests after a rate limit or a failure goes to the next account in line"
+	if p.KeepThroughRest {
+		keep = "on: a request stays on its account through a rest out of a rate limit or a failure, that its cache is not lost; out of quota or credit it moves as ever"
+	}
 	fmt.Println("stop at caps ·", stop)
 	fmt.Println("check usage near the cap ·", careful)
+	fmt.Println("keep through a rest ·", keep)
 	if uncapped > 0 {
 		fmt.Println(muted.Render(fmt.Sprintf("%d account(s) in use have no cap, so nothing holds them before the vendor does: magpie provider pool %s --cap 90", uncapped, p.ID)))
 	}
diff --git a/internal/cli/pool_keep_cli_test.go b/internal/cli/pool_keep_cli_test.go
new file mode 100644
index 000000000..39552d92e
--- /dev/null
+++ b/internal/cli/pool_keep_cli_test.go
@@ -0,0 +1,59 @@
+package cli
+
+// wssz527 (#4030): `magpie provider pool <id> --keep on` says a transient
+// rest — a rate limit, a failure — is no reason to move the pool's
+// accounts, and --keep off says it is again. Anything else is refused.
+import (
+	"os"
+	"path/filepath"
+	"testing"
+
+	"github.com/yetone/magpie/internal/agent"
+	"github.com/yetone/magpie/internal/provider"
+)
+
+func TestPoolKeepSaysItsPoolKeepsThroughARest(t *testing.T) {
+	home := t.TempDir()
+	t.Setenv("HOME", home)
+	t.Setenv("USERPROFILE", home)
+	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
+	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
+	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude"))
+	t.Setenv("COPILOT_HOME", filepath.Join(home, ".copilot"))
+	logins := filepath.Join(filepath.Dir(provider.Path()), "logins.json")
+	if err := os.MkdirAll(filepath.Dir(logins), 0o700); err != nil {
+		t.Fatal(err)
+	}
+	if err := os.WriteFile(logins, []byte(`[
+  {"agent": "copilot", "user": "mona", "seen": "2026-10-05T10:00:00Z", "on": true, "auth": {"oauth_token": "gho_m"}},
+  {"agent": "copilot", "user": "hubot", "seen": "2026-10-06T10:00:00Z", "on": true, "auth": {"oauth_token": "gho_h"}}
+]`), 0o600); err != nil {
+		t.Fatal(err)
+	}
+	provider.ForgetAccounts()
+	t.Cleanup(provider.ForgetAccounts)
+	t.Cleanup(agent.SyncCatalogSettled) // the pool's save syncs the agents' files behind it
+
+	if _, err := said(t, func() error { return poolCmd([]string{"copilot", "--keep", "on"}) }); err != nil {
+		t.Fatal(err)
+	}
+	p, err := provider.Find("copilot")
+	if err != nil {
+		t.Fatal(err)
+	}
+	if !p.KeepThroughRest {
+		t.Fatal("--keep on was not kept")
+	}
+	if _, err := said(t, func() error { return poolCmd([]string{"copilot", "--keep", "off"}) }); err != nil {
+		t.Fatal(err)
+	}
+	if p, err = provider.Find("copilot"); err != nil {
+		t.Fatal(err)
+	}
+	if p.KeepThroughRest {
+		t.Fatal("--keep off was not kept")
+	}
+	if _, err := said(t, func() error { return poolCmd([]string{"copilot", "--keep", "maybe"}) }); err == nil {
+		t.Fatal("maybe was taken for on or off")
+	}
+}
diff --git a/internal/gateway/affinity.go b/internal/gateway/affinity.go
index bbc6ba74f..3508b9331 100644
--- a/internal/gateway/affinity.go
+++ b/internal/gateway/affinity.go
@@ -615,6 +615,14 @@ func affine(scope, mode string, rotate, spread, inOrder, hoursOver bool, in http
 		// (01huadalang on Discord: a third ZCode account in use at once
 		// had the address banned). Strict, the user's own, keeps it
 		a.Why = "reserve"
+	case pl.order[at].Rest != nil && pl.order[at].Keeps:
+		// a pool set to keep through a transient rest (#4030): a short
+		// rate limit, or a failure that says nothing of why, is no reason
+		// to move what it answers. The seat holds — restLast holds the
+		// resting one back, so a ready one answers meanwhile and nothing
+		// is asked to death — and once the rest is over the conversation
+		// goes back to the account that has its cache
+		a.Why = "keep"
 	case pl.order[at].Rest != nil:
 		a.Why = "resting"
 	case lastBehind(pl.order, at):
@@ -702,6 +710,12 @@ func affine(scope, mode string, rotate, spread, inOrder, hoursOver bool, in http
 		a.Why = "cache"
 	}
 	switch a.Why {
+	case "keep":
+		// the seat holds without taking the request's front: the ready one
+		// answers this turn (restLast put the resting seat behind it), and
+		// the answer doesn't take the conversation over (seatKept, at the
+		// ask) — its own account has it back once the rest is over (#4030)
+		a.Kept = true
 	case "session", "turn", "cache":
 		a.Kept = true
 		if at > 0 {
@@ -1107,6 +1121,25 @@ func answered(key string, c candidate, turn int, u Usage) {
 	answeredStanding(key, c, turn, u, false)
 }
 
+// seatKept says the answer c gave stands in for a conversation whose own
+// account rests out of a short 429 its pool keeps through (#4030): the
+// conversation stays on that account — this turn's answer must not take
+// it over, and its own account has it back once the rest is over. A
+// conversation answered by its own account, and every answer to a pool
+// without the setting, is affected by none of this.
+func seatKept(ans candidate, aff *Affinity, cs []candidate) bool {
+	if !aff.Kept || ans.rest == aff.Last {
+		return false
+	}
+	for _, c := range cs {
+		if c.rest == aff.Last {
+			r, ok := restingOf(c)
+			return ok && c.keepsThrough(r)
+		}
+	}
+	return false
+}
+
 // answeredStanding is answered, with whether c stood in for a member
 // listed ahead of its own (standsInFor).
 func answeredStanding(key string, c candidate, turn int, u Usage, stoodIn bool) {
diff --git a/internal/gateway/fallback.go b/internal/gateway/fallback.go
index 3f693cf78..f727b275a 100644
--- a/internal/gateway/fallback.go
+++ b/internal/gateway/fallback.go
@@ -1293,7 +1293,11 @@ func asideOf(cs []candidate, q provider.Provider, fallback bool, from provider.P
 // them (creditsLast) behind both, those in their own order. Ahead of the
 // resting, a model its plugin says is busier than the user's
 // settings.BusyLoad (busyOf) goes behind the ready ones: it answers, only
-// after a wait in its vendor's queue (axelburks on Discord).
+// after a wait in its vendor's queue (axelburks on Discord). A pool set
+// to keep through a rest (KeepThroughRest) keeps its place through a
+// transient one — a rate limit, a failure that says nothing of why —
+// which the routing ordered: what its account has cached is worth more
+// than the wait (wssz527, #4030).
 func restLast(out []candidate, pl planned) ([]candidate, planned) {
 	if len(out) == 1 {
 		if r, ok := restingOf(out[0]); ok {
@@ -1310,6 +1314,7 @@ func restLast(out []candidate, pl planned) ([]candidate, planned) {
 		r, isResting := restingOf(c)
 		if isResting {
 			pl.order[i].Rest = &r
+			pl.order[i].Keeps = c.keepsThrough(r) // affine holds the seat (#4030)
 		}
 		load, isBusy := busyOf(c, over, now)
 		switch {
@@ -1329,6 +1334,21 @@ func restLast(out []candidate, pl planned) ([]candidate, planned) {
 	return append(append(append(ready, busy...), resting...), last...), pl
 }
 
+// keepsThrough says a rest is no reason to move what c answers: its
+// provider says a transient rest is not worth losing what its key or
+// account has cached (provider.KeepThroughRest, #4030). The request
+// still waits the rest out (restLast holds c back; a ready one answers)
+// — what keepsThrough saves is the conversation: affine holds its seat
+// (affinity.go), and the answer a ready one gives meanwhile doesn't take
+// it over. A rest out of quota or credit, a restricted account, and one
+// asked to verify itself still move it, as they do without the setting.
+func (c candidate) keepsThrough(r Rest) bool {
+	if !c.p.KeepThroughRest {
+		return false
+	}
+	return r.Why == failRate || r.Why == failOther
+}
+
 // busyOf is the load c's plugin last reported for its model, and whether
 // that is over the percent over (settings.BusyLoad; 0 is off). A model
 // with no load reported, or none within plugin.LoadFresh, isn't busy:
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index 607f8c2b6..9e8343dc7 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -5374,7 +5374,11 @@ func (s *Server) serve(w http.ResponseWriter, r *http.Request, from provider.Pro
 			// there is (imwhatiam123 on Discord: Stays: Strict moved a
 			// session from Qoder CN to WorkBuddy AI after a reply broke
 			// off, the stick gone and the retry routed as a new one)
-			if (hit == nil || !hit.Compact) && aff.Why != "strict" {
+			if (hit == nil || !hit.Compact) && aff.Why != "strict" && !seatKept(c, aff, plannedCs) {
+				// a seat a keeping pool holds through a short rest keeps the
+				// conversation over a ready one that breaks off too (#4030,
+				// seatKept): the retry goes back to its own account, which
+				// has not failed
 				unanswered(stuck, c)
 			}
 			if hw.looped != "" {
@@ -5421,7 +5425,13 @@ func (s *Server) serve(w http.ResponseWriter, r *http.Request, from provider.Pro
 			// a compaction a rule sent to a model of its own leaves the
 			// conversation, and the turn's size, where they were
 			if hit == nil || !hit.Compact {
-				answeredStanding(stuck, c, aff.Turn, call.Usage, standsInFor(c, plannedCs, plannedOrder))
+				// a seat a keeping pool holds through a short rest keeps
+				// the conversation over a ready one's answer (#4030,
+				// seatKept): its own account has it back once the rest is
+				// over
+				if !seatKept(c, aff, plannedCs) {
+					answeredStanding(stuck, c, aff.Turn, call.Usage, standsInFor(c, plannedCs, plannedOrder))
+				}
 				// what it answered, it holds: whatever it refused as too
 				// long on the way is forgotten (#3453)
 				forgetOverflow(stuck, c)
diff --git a/internal/gateway/pool_keep_affine_test.go b/internal/gateway/pool_keep_affine_test.go
new file mode 100644
index 000000000..e2b13e3de
--- /dev/null
+++ b/internal/gateway/pool_keep_affine_test.go
@@ -0,0 +1,184 @@
+package gateway
+
+// The affine half of a keeping pool (#4030): while the conversation's own
+// account rests out of a short 429 its pool keeps through, the seat holds
+// (affine says "keep", not "resting"), the ready one answers without
+// taking the conversation over, and once the rest is over the next turn
+// goes back to the account that has its cache. End to end: two turns, the
+// second refused with a short 429 and answered by the pool's other key,
+// a turn in between still on the ready one, and the turn after the rest
+// back on the first key.
+import (
+	"encoding/json"
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"strings"
+	"sync"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// A keeping pool's seat resting out of a rate limit: affine says "keep",
+// keeps it, and leaves the ready one in front — the seat doesn't take
+// the request while it rests. A pool without the setting says "resting",
+// unkept, as before.
+func TestPoolKeepHoldsTheSeatThroughARest(t *testing.T) {
+	for _, keep := range []bool{true, false} {
+		p := provider.Provider{ID: "kimi", KeepThroughRest: keep}
+		seat := candidate{p: p, model: "m", rest: "kimi@one"}
+		ready := candidate{p: p, model: "m", rest: "kimi@two"}
+		restAt(t, "kimi@one", failRate)
+		cs, pl := restLast([]candidate{seat, ready}, planned{order: make([]Weighed, 2)})
+		h := http.Header{}
+		h.Set("x-claude-code-session-id", "keep-rest-seat")
+		body := []byte(`{"messages":[{"role":"user","content":"hi"}]}`)
+		_, _, _, key := affine("t", provider.AffinitySession, false, false, false, false, h, provider.Chat, body, body, cs, pl)
+		answered(key, seat, 1, Usage{CacheRead: 50_000})
+		t.Cleanup(func() { sticks.Lock(); delete(sticks.m, key); sticks.Unlock() })
+		got, _, aff, _ := affine("t", provider.AffinitySession, false, false, false, false, h, provider.Chat, body, body, cs, pl)
+		if keep {
+			if aff.Why != "keep" || !aff.Kept {
+				t.Fatalf("why %s, kept %v, want keep and kept", aff.Why, aff.Kept)
+			}
+			if got[0].rest != "kimi@two" {
+				t.Fatalf("the resting seat was put in front: first %s", got[0].rest)
+			}
+			continue
+		}
+		if aff.Why != "resting" || aff.Kept {
+			t.Fatalf("no setting: why %s, kept %v, want resting and unkept", aff.Why, aff.Kept)
+		}
+	}
+}
+
+// keepKeeper is an Anthropic Messages upstream with two keys: k1 answers
+// its first ask, refuses its second with the transient 429 the reporter
+// logged (Kimi Code's "The engine is currently overloaded", a 429 with a
+// short Retry-After), and answers again after. k2 always answers.
+type keepKeeper struct {
+	mu    sync.Mutex
+	tried []string
+	asks  map[string]int
+}
+
+func (k *keepKeeper) ServeHTTP(w http.ResponseWriter, r *http.Request) {
+	io.ReadAll(r.Body)
+	key := r.Header.Get("x-api-key")
+	if key == "" {
+		key = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
+	}
+	k.mu.Lock()
+	k.tried = append(k.tried, key)
+	n := k.asks[key]
+	k.asks[key] = n + 1
+	k.mu.Unlock()
+	if key == "k1" && n == 1 {
+		w.Header().Set("Content-Type", "application/json")
+		w.Header().Set("Retry-After", "1")
+		w.WriteHeader(http.StatusTooManyRequests)
+		io.WriteString(w, `{"error":{"message":"The engine is currently overloaded, please try again later"}}`)
+		return
+	}
+	w.Header().Set("Content-Type", "text/event-stream")
+	for _, ev := range []string{
+		`{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"m","content":[],"usage":{"input_tokens":12,"output_tokens":1,"cache_creation_input_tokens":3000}}}`,
+		`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
+		`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"from ` + key + `"}}`,
+		`{"type":"content_block_stop","index":0}`,
+		`{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}`,
+		`{"type":"message_stop"}`,
+	} {
+		var t struct {
+			Type string `json:"type"`
+		}
+		json.Unmarshal([]byte(ev), &t)
+		io.WriteString(w, "event: "+t.Type+"\ndata: "+ev+"\n\n")
+	}
+}
+
+func (k *keepKeeper) mark() int {
+	k.mu.Lock()
+	defer k.mu.Unlock()
+	return len(k.tried)
+}
+
+func (k *keepKeeper) since(n int) []string {
+	k.mu.Lock()
+	defer k.mu.Unlock()
+	return append([]string(nil), k.tried[n:]...)
+}
+
+// Two turns of one conversation, then one while the refusal's rest still
+// holds, then one after it is over: a keeping pool's turn goes back to
+// the key that has the cache, and the ready one that answered meanwhile
+// never takes the conversation over. A pool without the setting moves it
+// for good, as before.
+func TestPoolKeepSendsTheConversationBackAfterTheRest(t *testing.T) {
+	const (
+		first = `{"model":"kk/m","messages":[{"role":"user","content":"hi"}]}`
+		again = `{"model":"kk/m","messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"yo"},{"role":"user","content":"more"}]}`
+	)
+	for _, keep := range []bool{true, false} {
+		name := "moves"
+		if keep {
+			name = "keeps"
+		}
+		t.Run(name, func(t *testing.T) {
+			fresh(t)
+			v := &keepKeeper{asks: map[string]int{}}
+			up := httptest.NewServer(v)
+			t.Cleanup(up.Close)
+			p := provider.Provider{ID: "kk", Name: "KK", Key: "k1", Models: []string{"m"}, Anthropic: up.URL + "/v1",
+				Keys: []provider.KeyAccount{{Key: "k2"}}, KeepThroughRest: keep}
+			if err := provider.Save(p); err != nil {
+				t.Fatal(err)
+			}
+			s := New()
+			if code, body := postAs(t, s, "k1sess", first); code != 200 {
+				t.Fatalf("first turn %d %s", code, body)
+			}
+			if got := v.since(v.mark() - 1); len(got) != 1 || got[0] != "k1" {
+				t.Fatalf("first turn tried %v, want k1", got)
+			}
+			// second turn: the pool's first key is refused with the short
+			// 429 and the other key takes the request
+			if code, body := postAs(t, s, "k1sess", again); code != 200 {
+				t.Fatalf("second turn %d %s", code, body)
+			}
+			if got := v.since(v.mark() - 2); len(got) != 2 || got[0] != "k1" || got[1] != "k2" {
+				t.Fatalf("second turn tried %v, want k1 then k2", got)
+			}
+			// while the rest holds, the ready key answers and takes the
+			// conversation over on its own cache — unless the pool keeps:
+			// then the seat stays on the refused one
+			if code, body := postAs(t, s, "k1sess", again); code != 200 {
+				t.Fatalf("mid-turn %d %s", code, body)
+			}
+			a := s.trace.routes[len(s.trace.routes)-1].Affinity
+			if keep && (a == nil || a.Why != "keep" || !a.Kept) {
+				t.Fatalf("mid-turn affinity %+v, want keep and kept", a)
+			}
+			if !keep && (a == nil || a.Why != "cache" || !a.Kept) {
+				t.Fatalf("mid-turn affinity %+v, want the other key's cache keeping", a)
+			}
+			// the rest runs out; the trace names what rested
+			for _, w := range s.trace.routes[len(s.trace.routes)-1].Order {
+				if w.Rest != nil {
+					expire(w.ID)
+				}
+			}
+			if code, body := postAs(t, s, "k1sess", again); code != 200 {
+				t.Fatalf("turn after the rest %d %s", code, body)
+			}
+			if got := v.since(v.mark() - 1); len(got) != 1 {
+				t.Fatalf("turn after the rest tried %v", got)
+			} else if keep && got[0] != "k1" {
+				t.Fatalf("a keeping pool went back to %s, want k1 (its cache)", got[0])
+			} else if !keep && got[0] != "k2" {
+				t.Fatalf("without the setting the turn went back to %s, want k2", got[0])
+			}
+		})
+	}
+}
diff --git a/internal/gateway/pool_keep_test.go b/internal/gateway/pool_keep_test.go
new file mode 100644
index 000000000..c4868c228
--- /dev/null
+++ b/internal/gateway/pool_keep_test.go
@@ -0,0 +1,92 @@
+package gateway
+
+// wssz527 (#4030): a pool whose accounts answer "overloaded" 429s for
+// seconds pays its conversations' whole prompts again whenever a
+// transient rest moves them to the pool's other account. A pool set
+// KeepThroughRest says a rest out of a rate limit, or a failure that
+// says nothing of why, is no reason to move what its accounts answer.
+// restLast holds the request back while an account rests either way —
+// a ready one answers, and the resting one is kept from being asked to
+// death — and marks a keeping candidate Keeps; affine
+// (pool_keep_affine_test.go) is what holds the conversation's seat
+// through the rest. A rest out of quota or credit still moves it, and
+// so does every rest of a pool without the setting.
+import (
+	"testing"
+	"time"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// restAt has key resting for a little while, for why.
+func restAt(t *testing.T, key, why string) {
+	t.Helper()
+	restingUntil.Lock()
+	restingUntil.m[key] = time.Now().Add(30 * time.Second)
+	restingUntil.note[key] = Rest{Why: why}
+	restingUntil.Unlock()
+	t.Cleanup(func() {
+		restingUntil.Lock()
+		delete(restingUntil.m, key)
+		delete(restingUntil.note, key)
+		restingUntil.Unlock()
+	})
+}
+
+// A keeping pool's account resting out of a rate limit, or after a
+// failure that says nothing of why, is held back with its rest recorded
+// and Keeps set: the ready one answers this request, and affine holds
+// the conversation's seat until the rest is over.
+func TestPoolKeepsThroughARateRest(t *testing.T) {
+	for _, why := range []string{failRate, failOther} {
+		p := provider.Provider{ID: "kimi", KeepThroughRest: true}
+		resting := candidate{p: p, model: "m", rest: "kimi@one"}
+		ready := candidate{p: p, model: "m", rest: "kimi@two"}
+		restAt(t, "kimi@one", why)
+		out, pl := restLast([]candidate{resting, ready}, planned{order: make([]Weighed, 2)})
+		if out[0].rest != "kimi@two" {
+			t.Fatalf("%s: the resting one was asked first: first %s", why, out[0].rest)
+		}
+		if pl.order[1].Rest == nil || pl.order[1].Rest.Why != why {
+			t.Fatalf("%s: the trace says nothing of its rest: %+v", why, pl.order[1].Rest)
+		}
+		if !pl.order[1].Keeps {
+			t.Fatalf("%s: the trace doesn't say the pool keeps through it", why)
+		}
+		// a ready one ahead of it stays ahead: nothing promotes it
+		out, _ = restLast([]candidate{{p: p, model: "m", rest: "kimi@two"}, {p: p, model: "m", rest: "kimi@one"}}, planned{order: make([]Weighed, 2)})
+		if out[0].rest != "kimi@two" {
+			t.Fatalf("%s: the resting one was put ahead: first %s", why, out[0].rest)
+		}
+	}
+}
+
+// A rest out of quota or credit holds a keeping pool's account back
+// without the Keeps mark: those are not over in seconds. And without
+// the setting, a rate rest holds it back unmarked as it did.
+func TestPoolStillMovesOnQuotaAndWithoutTheSetting(t *testing.T) {
+	for _, why := range []string{failQuota, failCredit} {
+		p := provider.Provider{ID: "kimi", KeepThroughRest: true}
+		resting := candidate{p: p, model: "m", rest: "kimi@one"}
+		ready := candidate{p: p, model: "m", rest: "kimi@two"}
+		restAt(t, "kimi@one", why)
+		out, pl := restLast([]candidate{resting, ready}, planned{order: make([]Weighed, 2)})
+		if out[0].rest != "kimi@two" {
+			t.Fatalf("%s: the resting one was asked first: first %s", why, out[0].rest)
+		}
+		if pl.order[1].Keeps {
+			t.Fatalf("%s: the trace says the pool keeps through it", why)
+		}
+	}
+	p := provider.Provider{ID: "kimi"}
+	resting := candidate{p: p, model: "m", rest: "kimi@one"}
+	ready := candidate{p: p, model: "m", rest: "kimi@two"}
+	restAt(t, "kimi@one", failRate)
+	out, pl := restLast([]candidate{resting, ready}, planned{order: make([]Weighed, 2)})
+	if out[0].rest != "kimi@two" {
+		t.Fatalf("no setting: the resting one was asked first: first %s", out[0].rest)
+	}
+	if pl.order[1].Keeps {
+		t.Fatal("no setting: the trace says the pool keeps through it")
+	}
+}
diff --git a/internal/gateway/trace.go b/internal/gateway/trace.go
index 5907532ac..7e40bcdd7 100644
--- a/internal/gateway/trace.go
+++ b/internal/gateway/trace.go
@@ -367,7 +367,12 @@ type Weighed struct {
 	Fit      int               `json:"fit,omitempty"`      // keyFit
 	Speaks   provider.Protocol `json:"speaks,omitempty"`   // a key made for one protocol only
 	Rest     *Rest             `json:"rest,omitempty"`     // resting after a failure, when the request came
-	Unlisted bool              `json:"unlisted,omitempty"`
+	// Keeps: its pool says a transient rest is no reason to move what it
+	// answers (#4030). restLast holds the request back while it rests all
+	// the same; affine holds the conversation's seat through the rest, and
+	// the answer a ready one gives meanwhile doesn't take the conversation
+	Keeps    bool `json:"keeps,omitempty"`
+	Unlisted bool `json:"unlisted,omitempty"`
 	// UseFirst: its provider is set to be used first, which Smart puts
 	// ahead of the other providers' (provider.Provider.UseFirst)
 	UseFirst bool `json:"useFirst,omitempty"`
diff --git a/internal/gui/providers.go b/internal/gui/providers.go
index 6bcd74245..c07fad7d5 100644
--- a/internal/gui/providers.go
+++ b/internal/gui/providers.go
@@ -2387,6 +2387,7 @@ func providerRoutes(mux *http.ServeMux, w Windows) {
 					in.CapStop, in.CapCareful = old.CapStop, old.CapCareful       // capstop, capcareful
 					in.UseFirst = old.UseFirst                                    // usefirst
 					in.NoStandIn = old.NoStandIn                                  // standin
+					in.KeepThroughRest = old.KeepThroughRest                      // keepthroughrest
 					in.Off = old.Off                                              // and this with off and on
 					if in.Contexts == nil {
 						in.Contexts = old.Contexts // a save that doesn't say
diff --git a/internal/provider/account_settings_test.go b/internal/provider/account_settings_test.go
index dc6b361a4..0064e2d9a 100644
--- a/internal/provider/account_settings_test.go
+++ b/internal/provider/account_settings_test.go
@@ -28,6 +28,7 @@ func TestAccountSettingsKept(t *testing.T) {
 		q.QuotaRest = 90
 		q.RestCap = 20
 		q.LimitRestOff = true
+		q.KeepThroughRest = true
 		q.Patience = 30
 		if err := Save(q); err != nil {
 			t.Fatal(err)
@@ -48,17 +49,17 @@ func TestAccountSettingsKept(t *testing.T) {
 		if !slices.Equal(got.ReplyHeaders, q.ReplyHeaders) {
 			t.Errorf("%s: reply headers %v, want %v", id, got.ReplyHeaders, q.ReplyHeaders)
 		}
-		if got.QuotaRest != 90 || got.RestCap != 20 || !got.LimitRestOff || got.Patience != 30 {
-			t.Errorf("%s: rests %d %d %v, patience %d", id, got.QuotaRest, got.RestCap, got.LimitRestOff, got.Patience)
+		if got.QuotaRest != 90 || got.RestCap != 20 || !got.LimitRestOff || !got.KeepThroughRest || got.Patience != 30 {
+			t.Errorf("%s: rests %d %d %v %v, patience %d", id, got.QuotaRest, got.RestCap, got.LimitRestOff, got.KeepThroughRest, got.Patience)
 		}
 		// set back, each is the default again
 		r := *got
 		r.AdditionalTools, r.ExtraBody, r.ReplyHeaders = false, nil, nil
-		r.QuotaRest, r.RestCap, r.LimitRestOff, r.Patience = 0, 0, false, 0
+		r.QuotaRest, r.RestCap, r.LimitRestOff, r.KeepThroughRest, r.Patience = 0, 0, false, false, 0
 		if err := Save(r); err != nil {
 			t.Fatal(err)
 		}
-		if got, _ := Find(id); got.AdditionalTools || len(got.ExtraBody) > 0 || len(got.ReplyHeaders) > 0 || got.QuotaRest != 0 || got.RestCap != 0 || got.LimitRestOff || got.Patience != 0 {
+		if got, _ := Find(id); got.AdditionalTools || len(got.ExtraBody) > 0 || len(got.ReplyHeaders) > 0 || got.QuotaRest != 0 || got.RestCap != 0 || got.LimitRestOff || got.KeepThroughRest || got.Patience != 0 {
 			t.Errorf("%s: left after clearing: %+v", id, got)
 		}
 	}
diff --git a/internal/provider/provider.go b/internal/provider/provider.go
index 856d9ee6d..ee55e8a57 100644
--- a/internal/provider/provider.go
+++ b/internal/provider/provider.go
@@ -559,6 +559,17 @@ type Provider struct {
 	// goes by the last reading, read again each minute. See
 	// gateway.carefulDoubt.
 	CapCareful bool `json:"capCareful,omitempty"`
+	// KeepThroughRest says a transient rest — a rate limit lifted in
+	// seconds, a failure that says nothing of why — is no reason to move
+	// a request off the key or account that its conversation answered:
+	// what the vendor cached of it is worth more than the wait, and a
+	// conversation moved pays its whole prompt again on the next account
+	// (wssz527, #4030: two Kimi Code accounts, a cache read at a rounding
+	// error and an uncached prompt at a large multiple). A rest out of
+	// quota or credit, a restricted account, and one asked to verify
+	// itself still move it, as they do without the setting. Off, the
+	// default. See gateway.restLast.
+	KeepThroughRest bool `json:"keepThroughRest,omitempty"`
 	// AccountNames is, for a subscription, the name the user gave each
 	// account they named (#1515: a team's seats told apart by who holds
 	// them, not by a masked email), by the account's name in lower case.
@@ -1101,6 +1112,7 @@ func accountSettings(a, pk Provider) Provider {
 	a.CapStop, a.CapCareful = pk.CapStop, pk.CapCareful
 	a.UseFirst = pk.UseFirst
 	a.NoStandIn = pk.NoStandIn
+	a.KeepThroughRest = pk.KeepThroughRest
 	a.AccountNames = pk.AccountNames
 	a.MaxConcurrency, a.PinUpstream = pk.MaxConcurrency, pk.PinUpstream
 	a.MaxAccounts = pk.MaxAccounts
diff --git a/internal/provider/routing.go b/internal/provider/routing.go
index b9bba9dfd..0707d3957 100644
--- a/internal/provider/routing.go
+++ b/internal/provider/routing.go
@@ -152,6 +152,18 @@ func SetCapCareful(id string, on bool) error {
 	return Save(*p)
 }
 
+// SetKeepThroughRest has a provider's keys and accounts keep the place
+// the routing gave them through a transient rest, or move behind one
+// again (Provider.KeepThroughRest).
+func SetKeepThroughRest(id string, on bool) error {
+	p, err := Find(id)
+	if err != nil {
+		return err
+	}
+	p.KeepThroughRest = on
+	return Save(*p)
+}
+
 // SetCountFree has every model of a provider count as free for the
 // routings that weigh it, or go by its vendor's word again
 // (Provider.CountFree).
-- 
2.50.1 (Apple Git-155)

```

</details>

**Branch with the commit**: [`hunt-20261111-rf-4030`](https://github.com/ggbdpq/magpie/tree/hunt-20261111-rf-4030) (head `5ec718b74ceb5ce7e327b4540748dae46f50bb95`), rebased onto current `upstream/main` (`4b29709ec`); on a fresh checkout at that tip `git am` applies it as is (replayed on a detached worktree, resulting tree identical to the branch head, checked by tree hash).

Verification this round (on `4b29709ec` + this commit, `GOCACHE` pinned):

| Check | Result |
| --- | --- |
| `TestPoolKeepsThroughARateRest`, `TestPoolStillMovesOnQuotaAndWithoutTheSetting`, `TestPoolKeepHoldsTheSeatThroughARest`, `TestPoolKeepSendsTheConversationBackAfterTheRest`, `TestPoolKeepSaysItsPoolKeepsThroughARest` | green with the patch |
| Ablation: `keepsThrough` made constant false (build intact — the setting reads, the keeping dies) | three faces red at once: the seat answers `why resting, kept false, want keep and kept`; the conversation is taken over mid-rest (`want keep and kept` on the ready one's answer); the `Keeps` marking gone in `restLast`; restored: green |
| `go test -tags nogui -timeout 40m -count=1 ./internal/gateway/` (whole package) | ok (919.4s), zero failures |
| `go test -tags nogui -timeout 20m -count=1 ./internal/gui/` (whole package) | two failures, both the machine's pre-existing reds (`TestProxyCheckSaysAProxyPassedBy`, `TestSessionReadsRoutes` — red at the parent commit too, on the standing list); nothing else |
| `go test ./internal/provider -run '^TestAccountSettings\|KeepThrough'` | ok |
| `gofmt -l` on the touched files | prints nothing (one struct-tag alignment fixed) |
| `go vet -tags nogui ./internal/gateway/ ./internal/cli/ ./internal/provider/` | clean |
| `go build -tags nogui ./...` darwin / `GOOS=linux` / `GOOS=windows` | clean |

**Siblings**: `rg KeepThroughRest` — the setting is read by `keepsThrough` (one definition, `fallback.go`), marked in `restLast`, held by `affine`, saved by the CLI (`pool_cli.go`), the provider editor's keep-list (`gui/providers.go`) and the account-settings round-trip (`provider.go`); each consumer is this patch's own wiring. The `busyBehind` seat-mover in `affine` and main's vendor-timed holds are untouched — a vendor-named hold moves the conversation even with the setting, which is the review's "pacing" preserved.

**Not verified**: the reporter's Kimi Code subscription with a real 429 storm (the tests use fake vendors whose refusals shape as the report's); the GUI editor's rendering of the keep switch beyond the keep-list line.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
