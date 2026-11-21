Rework per @yetone's review ([the review](https://github.com/yetone/magpie/issues/5494#issuecomment-6708732915)): the patch deleted any `openai_base_url` pointing at magpie whenever the stash named a source, so a user who wired magpie in by hand (#856's usage) beside an expired `codex.provider` stash had their base URL taken away on the next sync ("sync 0 took the user's base URL away") — this rework marks the base URL the takeover actually introduces (`codex.took_base`) and only takes a marked one down, and forgets an unmarked stash as the expired thing it is instead of acting on it.

@yetone @MuRanSea's report: a takeover of a provider of the user's (CC Switch's `custom`) stashes the source and moves its threads onto magpie, but bringBack — the move back — read where Codex is on *now* rather than where the threads came from. The switch back to custom landed after magpie was already off the config (15:48, the app.log sequence in the issue), so at the sync that moved the threads the config named no provider and Codex read its default: every thread was filed on openai — the reporter's own log lines, `242 thread(s) started on custom moved to magpie` then `242 thread(s) on magpie moved back to openai` — and Codex then refused each one from custom ("This chat uses openai, but your current provider is custom"), its model picker reading unavailable.

**Root cause**: `bringBack` (internal/agent/codex.go) takes its target from `sessions.CodexProviderIn(dir)` — the config's `model_provider`, defaulting to openai when the key is gone — instead of the stashed source. The config is right only when the Disconnect happened first (`unroute` unstashes the provider into it); any path where magpie leaves the config without a Disconnect — a hand edit, another CC Switch pick, `defer bringBack()` in the sync after the user switched — files every magpie thread on whatever the config names then.

**The fix**: bringBack gives the threads back to the stashed source, the config answering only for a move magpie has no stash of (an older magpie's, its stash gone — exactly today's behavior there). The review's two directions answered as follows. (1) The takeover's own base URL is now marked where the takeover introduces it — `codex.took_base`, stashed beside `model_provider` only when there was no `openai_base_url` to begin with — and bringBack takes down a marked one alone; a base URL with no mark is the user's own, by hand (#856), and stays, whatever the stash says. The mark goes where the `codex.failover` mark goes (dropped as dropBase takes the URL down, so a later hand-written one can't be mistaken for a takeover's). (2) A stash with no mark behind a base URL that points at magpie is an expired one — a takeover long since re-wired away by hand, whose own give-back would have unstashed it (unroute) — and is forgotten instead of driving the move, here or at any sync after. The guards from the first patch stand: a live beside wiring keeps out (joined or beside the sign-in, the threads are bringBeside's to move and giveBeside's to give back at the Disconnect), and Unwire's own path is unchanged: it forgets the stash before bringBack runs and its unroute has already restored the config, so the fallback reads the right provider there.

<details><summary>patch: codex: threads move back to the provider the takeover took them from (#5494) — git am applies it as is; SHA-256 first 16: 75c577efc09d5f55</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 8 Nov 2026 02:52:12 +0800
Subject: [PATCH] codex: threads move back to the provider the takeover took
 them from (#5494)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

bringBack read where Codex is on now and filed every magpie thread
there. The switch back to the user's own provider can land after magpie
is already off the config — a hand edit, another CC Switch pick, the
sync's own defer bringBack — and then the config names no provider and
Codex reads its default, openai: a takeover of a provider of the
user's (CC Switch's "custom") sent its threads back to openai, and
the switch back to custom found them all misfiled (the reporter's
app.log: 242 + 1,626 threads started on custom moved to magpie at
15:36:01, moved back to openai at 15:36:05, and the switch back to
custom at 15:48 leaving every one of them refused: "This chat uses
openai, but your current provider is custom"). The source is in the
stash all along (codex.provider, bringOver's source), and unroute puts
it back into the config only when the Disconnect runs before the
threads move.

bringBack now gives the threads back to the stashed source, the config
answering only for a move magpie has no stash of. The takeover's other
wire comes down with it: the base URL the takeover writes beside
model_provider is taken down too, and only that one — it is marked
(codex.took_base) where the takeover introduces it, and a base URL
with no mark is the user's own, by hand (#856): it stays, and the
stash beside it goes with it, forgotten as the expired thing it is —
a takeover still to give back would have its wire marked, and an
expired one driving every sync after is what took the user's base URL
away (the review's probe). A live beside wiring keeps out (joined or
beside, the threads are bringBeside's to move and giveBeside's to give
back at the Disconnect), and unwire's own path is unchanged: it
forgets the stash before bringBack runs and its unroute has already
restored the config.

Tests (codex_threads_back_test.go):
TestCodexThreadsBackToTheirSource — a takeover of custom, a thread
brought onto magpie, the config's provider taken away before the sync
that moves the threads: back on custom, the takeover's own base URL
down with it. TestCodexKeepsTheUsersBaseURL — the review's probe: the
user's own base URL to magpie (#856) beside an expired codex.provider
stash, one sync: both stay, the stash forgotten.
---
 internal/agent/codex.go                   |  54 ++++++++++-
 internal/agent/codex_threads_back_test.go | 104 ++++++++++++++++++++++
 2 files changed, 157 insertions(+), 1 deletion(-)

diff --git a/internal/agent/codex.go b/internal/agent/codex.go
index 4cf68af07..06ca10b34 100644
--- a/internal/agent/codex.go
+++ b/internal/agent/codex.go
@@ -772,6 +772,48 @@ func codexIn(at place) *Agent {
 		if to == magpieID {
 			return
 		}
+		// where the threads belong: the provider Codex was on before magpie
+		// took it over (stash codex.provider, bringOver's source, kept for
+		// Unwire to put back). The config reads where Codex is on *now*, and
+		// the switch back to the user's own can land after magpie is already
+		// off it — a hand edit, another CC Switch pick, this sync's own
+		// defer — so "now" can be a channel the threads never belonged to:
+		// they were filed there, and the provider they came from no longer
+		// lists them (#5494: custom → magpie → openai, wanted back on
+		// custom). The stashed source is where they go; the config keeps
+		// answering for a move magpie has no stash of. A live beside wiring
+		// keeps out: joined or beside the sign-in, the threads Codex
+		// resumes are the ones bringBeside moved onto OpenAI, and they go
+		// back to their provider at the Disconnect (giveBeside), not here.
+		if src := stashShared()[at.key("codex.provider")]; src != "" && src != magpieID && src != ccSwitchOfficial && !joined() && !beside() {
+			if viaBase() && stashShared()[at.key("codex.took_base")] != "1" {
+				// the base URL is the user's own, by hand (#856) — no mark
+				// of magpie's stands behind it — so the stash beside it is
+				// an expired one: a takeover long since re-wired away by
+				// hand, whose give-back would have unstashed it (unroute).
+				// Forgotten, it moves nothing, here or at any sync after;
+				// the config answers where the threads go, as it did
+				// before.
+				forget(at.key("codex.provider"))
+			} else if to != src {
+				to = src
+				// the takeover's other wire comes down with it: the base
+				// URL the takeover wrote beside model_provider, marked
+				// (codex.took_base), is left in the config when the switch
+				// back missed the Disconnect, and reads there as a live
+				// beside wiring — bringBeside would file the threads just
+				// given back onto OpenAI (#5494). Codex is not being
+				// served through it: the takeover named magpie its
+				// provider, never the base URL. One the user wrote by
+				// hand carries no mark and stays (#856).
+				if viaBase() {
+					forget(at.key("codex.failover"), at.key("codex.took_base"))
+					if err := edit.DelTOMLTop(path, "openai_base_url"); err != nil {
+						log.Println("codex: dropping the base URL the takeover left:", err)
+					}
+				}
+			}
+		}
 		// in place first where it can be (bringOver's, and those started
 		// on magpie that Codex hasn't packed): no copy of each, no rewrite
 		if len(to) == len(magpieID) {
@@ -1302,7 +1344,7 @@ func codexIn(at place) *Agent {
 	// account than leave its ChatGPT state
 	out := func() bool { return stashShared()[at.key("codex.login")] != "chatgpt" && codexUsedUp() }
 	dropBase := func() error {
-		forget(at.key("codex.failover"))
+		forget(at.key("codex.failover"), at.key("codex.took_base"))
 		if !viaBase() {
 			return nil
 		}
@@ -1799,12 +1841,22 @@ func codexIn(at place) *Agent {
 				{Path: "model_catalog_json", Value: catalogRef},
 				{Path: "model", Value: v},
 			}
+			tookBase := false
 			if u := get("openai_base_url"); u == "" || viaBase() {
 				kv = append(kv, edit.KV{Path: "openai_base_url", Value: at.codexURL()})
+				// a base URL magpie introduces here is the takeover's own,
+				// marked (codex.took_base) for bringBack to take down with
+				// the takeover when the switch back missed the Disconnect.
+				// One already there is the user's own, by hand (#856): it
+				// stays, never magpie's to take.
+				tookBase = u == ""
 			}
 			if err := edit.SetTOMLTop(path, kv...); err != nil {
 				return err
 			}
+			if tookBase {
+				stash(map[string]string{at.key("codex.took_base"): "1"})
+			}
 			if err := takeTables(); err != nil {
 				return err
 			}
diff --git a/internal/agent/codex_threads_back_test.go b/internal/agent/codex_threads_back_test.go
index 1f5b88a53..9982e8c5c 100644
--- a/internal/agent/codex_threads_back_test.go
+++ b/internal/agent/codex_threads_back_test.go
@@ -146,3 +146,107 @@ func TestCodexThreadsComeBackOffMagpie(t *testing.T) {
 		}
 	})
 }
+
+// #5494: a takeover of a provider of the user's (CC Switch's "custom")
+// stashes it as the source, and bringOver moves its threads onto magpie.
+// The switch back to it can land after magpie is already off the config —
+// a hand edit, another CC Switch pick, this very sync — and bringBack then
+// read where Codex was on *now*: no model_provider key, Codex's default,
+// openai. Every thread was filed there — custom → magpie → openai — and
+// the user's own provider no longer listed them ("This chat uses openai,
+// but your current provider is custom"). The stashed source is where they
+// go back; the config keeps answering for a move magpie has no stash of.
+func TestCodexThreadsBackToTheirSource(t *testing.T) {
+	const moved = "019a0000-0000-7000-8000-0000000000c1"
+	home, _ := codexHome(t, "", `model = "gpt-5.4"
+model_provider = "custom"
+
+[model_providers.custom]
+name = "custom"
+base_url = "https://relay.example/v1"
+wire_api = "responses"
+`)
+	dir := filepath.Join(home, ".codex")
+	path := filepath.Join(dir, "config.toml")
+	cx := codex(home)
+	// the takeover names magpie and stashes custom, the provider Codex was on
+	if err := cx.Fields[0].Set("fake/m1"); err != nil {
+		t.Fatal(err)
+	}
+	if p, _ := edit.GetTOMLTop(path, "model_provider"); p != "magpie" {
+		t.Fatalf("provider %q, want magpie", p)
+	}
+	// a thread started on custom before the takeover follows onto magpie
+	// (bringOver), as the reporter's 242 + 1,626 did
+	codexThreadOn(t, dir, moved, "custom")
+	if err := cx.Sync(); err != nil {
+		t.Fatal(err)
+	}
+	if p := codexRowOn(t, dir, moved); p != "magpie" {
+		t.Fatalf("thread on %q, want magpie after bringOver", p)
+	}
+	// magpie is already off the config when the threads move back: the
+	// switch back to custom comes after this sync (a hand edit here), so
+	// the config names no provider and Codex reads its default, openai.
+	// The model goes with it — the user is back on their relay's models —
+	// or Sync would wire magpie in again for the magpie model it still
+	// names (#322's self-heal).
+	if err := edit.DelTOMLTop(path, "model_provider"); err != nil {
+		t.Fatal(err)
+	}
+	if err := edit.SetTOMLTop(path, edit.KV{Path: "model", Value: "zcode/GLM-5.3-Flash"}); err != nil {
+		t.Fatal(err)
+	}
+	if err := cx.Sync(); err != nil {
+		t.Fatal(err)
+	}
+	if p := codexRowOn(t, dir, moved); p != "custom" {
+		t.Fatalf("thread on %q, want custom, the provider stashed before the takeover — not the openai the config fell back to", p)
+	}
+	// the takeover's own wire comes down with the threads: left in, it
+	// reads as a live beside wiring and bringBeside would file the
+	// threads just given back onto OpenAI
+	if u, _ := edit.GetTOMLTop(path, "openai_base_url"); u != "" {
+		t.Fatalf("openai_base_url %q stayed, the takeover's own write — a live beside wiring to bringBeside", u)
+	}
+}
+
+// The maintainer's probe of the first patch: a user's own openai_base_url
+// pointing at magpie (#856's usage — theirs, by hand, to have Codex's own
+// models go through magpie), beside an expired codex.provider stash from a
+// takeover long gone. The patch took the stash for a live takeover, moved
+// the threads to it and took the user's base URL down with them ("sync 0
+// took the user's base URL away"); main never touched either. The
+// takeover's own mark (codex.took_base) is what puts a base URL in
+// magpie's keeping: a stash without it is an expired one, and moves
+// nothing.
+func TestCodexKeepsTheUsersBaseURL(t *testing.T) {
+	const moved = "019a0000-0000-7000-8000-0000000000e1"
+	home, read := codexHome(t, "", "")
+	dir := filepath.Join(home, ".codex")
+	path := filepath.Join(dir, "config.toml")
+	// the user's own wiring, written by hand: no provider of magpie's
+	// anywhere, just their base URL
+	cfg := "model = \"gpt-5.4\"\nopenai_base_url = \"" + here(home).codexURL() + "\"\n"
+	if err := edit.WriteAtomic(path, []byte(cfg)); err != nil {
+		t.Fatal(err)
+	}
+	// an expired codex.provider stash: a takeover's, every other half of
+	// which is long gone — a takeover still to give back would have its
+	// base URL marked
+	stash(map[string]string{"codex.provider": "custom"})
+	codexThreadOn(t, dir, moved, "magpie")
+	cx := codex(home)
+	if err := cx.Sync(); err != nil {
+		t.Fatal(err)
+	}
+	if u, _ := edit.GetTOMLTop(path, "openai_base_url"); strings.TrimSuffix(u, "/") != here(home).codexURL() {
+		t.Fatalf("sync 0 took the user's base URL away: openai_base_url = %q, want the user's own:\n%s", u, read())
+	}
+	if p := codexRowOn(t, dir, moved); p != "openai" {
+		t.Errorf("thread on %q, want openai — an expired stash is no takeover to give back to", p)
+	}
+	if s := stashShared()["codex.provider"]; s != "" {
+		t.Errorf("the expired stash stayed (%q), to drive every sync after", s)
+	}
+}
-- 
2.50.1 (Apple Git-155)


```

</details>

**Branch with the commit**: [`fix/5494-codex-session-fallback-r2`](https://github.com/ggbdpq/magpie/tree/fix/5494-codex-session-fallback-r2) (head `43abff63c02c447c9688945bf15e49b3c23617e5`), one commit on the current `upstream/main` (`46b10af8`); on a fresh detached checkout of the tip `git am` applies clean, tree diff = 0.

| Check | Result |
| --- | --- |
| `TestCodexKeepsTheUsersBaseURL` (new, the review's probe: the user's own base URL to magpie #856 beside an expired `codex.provider` stash, one sync) | red under the first patch's semantics — the run logs the probe's own shape (`1 thread(s) on magpie moved back to custom`, then `sync 0 took the user's base URL away: openai_base_url = ""`); on untouched `upstream/main` `46b10af8` the base URL and the thread stay as main leaves them and the test fails on its third assertion alone (`the expired stash stayed ("custom"), to drive every sync after`) — pass after the rework on all three |
| `TestCodexThreadsBackToTheirSource` (the first patch's test, now also asserting the takeover's own base URL comes down) | red on the parent commit's codex.go (`thread on "openai", want custom`) — pass after |
| the move/give-back family, selected: `TestCodexThreadsComeBackOffMagpie`, `TestCodexBesideBringsTakenProvidersThreads`, `TestCodexMirrorAtTopJoinsWithItsThreads`, `TestCodexMirrorThreadsFollowOpenAI`, `TestCodexCCSwitchOfficialOpenAIMirror`, `TestCodexTakeoverThreadComesBackOnceQuiet` | pass |
| `go test ./internal/agent/ -tags nogui -timeout 25m -count=1` | FAIL — `TestMothX` alone (mothx_test.go:154, the MothX plugin agent's own `Detected()` check on this machine; re-run selected on untouched `upstream/main` `46b10af8`: same dump, unrelated to this change, which touches only codex.go and its test file). Every other test in the package passes, the family above included |
| `go test -tags nogui ./...` (temp HOME, pinned Go caches) | FAIL — 84 packages ok, four packages failing, five tests, every one re-run selected on untouched `upstream/main` `46b10af8` and failing the same there, none attributable to this change (which touches only codex.go and its test file): `internal/agent` `TestMothX` (mothx_test.go:154, the MothX plugin agent's own `Detected()` on this machine), `internal/gui` `TestProxyCheckSaysAProxyPassedBy` (a proxy check against the machine's proxy) and `TestSettingsSaveKeepsWhatItDoesNotSend` (settings_keep_test.go:241, `GroupFirstToken: not sent by the Settings page`), `internal/cli` `TestSettingsCLISetsWhatTheWindowSaves` (settings_parity_test.go:98, `` `magpie settings` sets "groupFirstToken", which no page sends ``), `internal/plugin` `TestHostToldTheGatewayAddress` (host_addr_test.go:78, "after the port moved to 3592 the plugin was told MAGPIE_ADDR=127.0.0.1:3591", a port race in the test) |
| targeted `-race` (`TestCodexThreadsBackToTheirSource`, `TestCodexKeepsTheUsersBaseURL`, `TestCodexThreadsComeBackOffMagpie`, `TestCodexBesideBringsTakenProvidersThreads`) | pass 6.9s |
| `gofmt -l internal/agent/codex.go internal/agent/codex_threads_back_test.go` | prints nothing |
| `go vet ./...`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet ./...` | clean |
| `go build`; `GOOS=linux go build -tags nogui`; `GOOS=windows go build` | clean (darwin's `ld: warning: ignoring duplicate libraries` is the toolchain's, before this change too) |
| Ablation | flipping bringBack's fork off — the expired-stash branch, this rework's semantic line — turns `TestCodexKeepsTheUsersBaseURL` red with the probe's own line (`sync 0 took the user's base URL away`), `git diff` verified in place; restored, green. The parent commit's codex.go (no bringBack redirect at all) turns `TestCodexThreadsBackToTheirSource` red; restored, green |
| Re-verified on `upstream/main` `46b10af8` (2026-11-08) | the commit is one commit on the current tip (branched from it as it stands, no rebase needed); `git am` applied on a fresh detached checkout of the tip, tree diff = 0 |

**Not verified**: the reporter's machine — a real CC Switch round trip with a real Codex app and its state databases stays with them (the fix's semantics on live `state_<n>.sqlite` rows are covered by the same `sessions` moves every existing thread test drives, but no real Codex ran here). The in-place repair of already-misfiled threads (the issue's ask #3) is **not** in this commit: the trash copies each move keeps (`trash/codex-provider/<ts>-<id>/`, with `move.json` naming from/to/files) are the rollback material, but a repair tool for users already hit — restoring by backup evidence rather than blanket-renaming openai threads, which the issue rightly warns against — is its own piece of work, left for a follow-up.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)

