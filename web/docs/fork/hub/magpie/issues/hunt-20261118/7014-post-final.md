The reported dangle: `magpie-desktop-models.json` went away while `config.toml` kept naming it, and Codex Desktop refused its config. Following the reporter's narrowing (the `deskCatalog` comparison), this patch makes the ownership comparison resolve the symlinks the two spellings hold.

**Root cause:** a Codex Home moved to an external volume and left as a symlink spells one catalog two ways. `deskCatalog` compared `model_catalog_json` with the resolved desk path by spelling alone, so the alias the config named missed, and `deskList` took its own file for the user's — "A model_catalog_json of the user's own stands: theirs is what Codex reads" — and removed it with a bare `os.Remove`, which is why no unlink shows in any log. The config kept naming the gone file, and Codex refused its config (`Unable to load ChatGPT configuration`, `No such file or directory (os error 2)`).

**The fix:** `deskCatalog` resolves the symlinks the two folders hold before comparing (`resolveRidingMissing`), a missing file riding on its resolved folder — the file being gone is exactly the state this comparison decides about. WSL spellings keep their native handling; the relative-reference and the user's-own-key semantics are unchanged. The product contract in `docs/subsystems/agent-wiring.md` notes it.

**Source:** reported in #7014; the reporter's narrowing named `deskCatalog` and the remove branch, and their working workaround (a relative reference) confirmed the comparison is the owner. Reproduced here with a symlinked sandbox home, not their volume.

**Red without the fix:** `TestCodexDesktopListSymlinkedHome` (new, built on the reporter's suggested regression shape — the home a symlink to an external folder, `CODEX_HOME` naming the resolved one, the config naming the catalog by its alias, the app reader alternately present and absent): the first sync removes the file the config still names — `the catalog named by its alias was taken for the user's and removed`. Restoring the fix passes, and every stage leaves the key naming an existing catalog or gone.

**Siblings:** `ownCatalog` (magpie-as-provider's own catalog — the same spelling-only comparison, eight call sites) has the same miss: a config naming `magpie-models.json` by its alias would be taken for the user's, a gone list unnamed instead of regenerated. The same one-line change applies (`resolveRidingMissing(c) == resolveRidingMissing(catalogPath)`); I kept it out of this patch only because its asProvider fixture needs more than the desk test carries — say the word and it comes as a follow-up. `theirListGone` and the hand-wired checks key on other files and spellings.

**When the read fails:** unchanged — a catalog whose folder cannot be resolved compares by its unresolved spelling, a missing file rides its folder, and `deskGone` with the unknown-leaves-the-file-as-it-was semantics are untouched.

| Check | Result |
| --- | --- |
| `TestCodexDesktopListSymlinkedHome` | Green at final head: join keeps the alias-named catalog and key; the app reader gone takes key and file out whole; back again names and writes anew |
| Ablation (comparison reverted, test kept) | `the catalog named by its alias was taken for the user's and removed`; restored, green |
| Targeted `-race` (desk family) | Pass (`TestCodexDesktop`, `TestCodexDesktopList` families) |
| `go test -tags nogui -timeout=45m -count=1 ./internal/agent/` | Exit 1 with `TestMothX` alone (345.8s) — the documented local-proxy environment failure on this machine; the same test fails on bare base per the #6867 verification run here |
| `gofmt -l` changed files, `git diff --check` | No output / clean |
| `go vet ./…`; `GOOS=linux go vet -tags nogui ./…`; `GOOS=windows go vet ./…` | All exit 0 |
| darwin/windows `go build ./…`; linux `go build -tags nogui ./…` | All exit 0 |
| Strict `git am` on base `b332ef7ef` | Applies cleanly; resulting tree equals final head; author remains `ggbdpq <ggbdpq@gmail.com>` |

**Not verified:** the reporter's macOS 27.3 volume and Codex Desktop 26.1111.21308 end-to-end; Windows symlink behavior (WSL/Windows spellings keep their existing handling; cross-platform vet/build only); which process wrote the file away in the reporter's timeline — the comparison fix removes the misclassification that made that removal reachable, and the removal itself is `os.Remove`, silent by design.

**Left:** the reporter's asks beyond this comparison — regenerating a missing managed catalog before the app restarts regardless of cause, and a single-model `magpie visible <agent> +<model>` — are product surface for you; the comparison fix closes the misclassification this incident ran through.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Branch with the commit**: [fix/7014-desk-catalog-symlink](https://github.com/ggbdpq/magpie/tree/fix/7014-desk-catalog-symlink), head `dbe34f6ebf763e04683e13aa6a922d0345efe51b`.

<details><summary>patch: agent: a desk list named by a symlinked Home's alias is magpie's own (#7014) — git am applies it as is; SHA-256 first 16: 2894db806273b59a</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 19 Nov 2026 04:03:21 +0800
Subject: [PATCH] agent: a desk list named by a symlinked Home's alias is
 magpie's own (#7014)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: deskCatalog compared model_catalog_json with the resolved
desk path by spelling alone. A Codex Home moved to an external volume
and left as a symlink spells one catalog two ways — the config named
the alias while CODEX_HOME said the resolved folder — so the
comparison missed, deskList took its own file for the user's and
removed it, and the config kept naming the gone file: Codex refused
its config ("Unable to load ChatGPT configuration", #7014). The
comparison now resolves the symlinks the two folders hold, a missing
file riding on its resolved folder — gone is exactly the state it
decides about. WSL spellings keep their native handling.

Run: TestCodexDesktopListSymlinkedHome (new) — joining with the config
naming the alias keeps the catalog and the key; the app reader gone
takes the key and the file out whole; back again names and writes it
anew. Without the fix the first sync removes the file the config still
names. See the issue post for the matrix.

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/agent-wiring.md      |  2 +-
 internal/agent/codex.go              | 26 ++++++++-
 internal/agent/codex_desktop_test.go | 87 ++++++++++++++++++++++++++++
 3 files changed, 113 insertions(+), 2 deletions(-)

diff --git a/docs/subsystems/agent-wiring.md b/docs/subsystems/agent-wiring.md
index 5b74ce706..4f0f422a3 100644
--- a/docs/subsystems/agent-wiring.md
+++ b/docs/subsystems/agent-wiring.md
@@ -137,7 +137,7 @@ something else shows up as drift.
 - Every other agent's own models (`ownProvider` in [`agents.go`](../../internal/agent/agents.go), the provider list read from its own auth file or config: Pi, OpenCode, Goose, Crush, Cline, Hermes, the WSL twins and the rest; omp's `ompOwnOptions`) say `Direct` with the provider's name: each is asked of that vendor on the agent's own sign-in or key, so a pick takes the agent off magpie. The picker tags them direct, lists them after magpie's, and asks before such a pick turns 「接入」 off (maxleebeta on Discord: Pi's own OpenCode Go model switched it off with nothing said; `TestOwnModelsSayTheyGoDirect`, `agent-own-direct.test.cjs`).
 - A line magpie writes into an agent's TOML, YAML or dotenv config gets a comment line of its own just above it, `# magpie: <what it is>; <how to undo it>` (`edit.Mark`, set to `agent.lineNote` by the CLI's `run` in [`mark.go`](../../internal/agent/mark.go); the edit side in [`internal/edit/mark.go`](../../internal/edit/mark.go)). Jevik_AI on X deleted magpie's folders by hand, and Codex's `config.toml` kept `openai_base_url` on the gateway with nothing in it naming magpie: every turn was a 502. Only a one-line scalar that points at the gateway or names magpie's model list gets one, and only when the write adds or changes that line, or it had a note already; a line of the user's own that magpie leaves as it is gets none. The note is never on the value's line: Grok App's `providers.rs` reads the rest of a line as the value. Every write takes the notes out first and puts them back over the lines that still need one, so a note goes with its line and a Disconnect leaves none. A YAML note that would change what the file reads as isn't added (`sameYAMLValue`). JSON has no comments and gets none. Tests set no `Mark`, so their exact bytes stay; `TestMarkedLinesEveryAgent` connects every agent with notes on and checks each gateway line has one, a second sync writes nothing, and Disconnect leaves none; `TestCodexMarkedLines`, `internal/edit`'s `TestMark*`.
 - Codex signed in to ChatGPT stays beside its sign-in (`openai_base_url`) unless the user picks magpie API. magpie becomes its provider only while the Codex app holds the active account, which it sends nothing for: `/wham/usage` says it isn't allowed, and it has no credits and isn't a workspace still within its overage (`codexHeld`, read by `provider.CodexUsedUp`). With Codex switched off or removed in magpie (`leftAlone`), whose allowance magpie otherwise reads nothing of, the active account is still read for this alone while Codex takes magpie's models beside its sign-in or magpie is its provider for the held account (`Agent.HoldMatters`, through the `provider.CodexHoldMatters` hook; `codexHoldReading`): once a minute at most, with the token as Codex keeps it, never renewed or written (`codexTokenAsKept`), and nothing shown on the Usage page. Before, turning Codex off in magpie after its allowance ran out left the Codex app greying Send for magpie's models through restarts, and one already moved was put back on the held account (sherlock_23333 on X; `TestCodexHoldReadLeftAlone`, `TestCodexHoldMatters`). Where the app goes by what usage can't show (an experiment's gate, a reserve, a Team plan's overage under the reserve experiment), it counts as held: a wrong move costs ChatGPT extras, a missed one every turn. A reading kept, on disk through a failed read or in memory (the catalog sync's `CodexUsedUpKnown`, reads held back while allowances are read only when asked), stops saying held once a window used up when it was read has started again (`holdEnded`, `loginUsageEntry.asOf`); a hold with no window used up stays till a fresh read. Before, an account that had run out read as held from memory past its reset, so Codex signed back in to it had magpie as its provider and the Codex app showed "magpie" for its account (davezfr on X). The account the user keeps Codex signed in to (Keep signed in to it, `KeepLoginAs`, or kept on the first with none named; `provider.CodexSignInKept`) is not taken over on one of Codex's own models (the takeover's stand-in for one, `codex.out_own`, counts as it), held or not: the app shows it, and greys Send till its reset as it does without magpie. Before, account 1, used up with no credits and picked in the sign-in, showed "magpie" while account 2 showed itself (davezfr on X, after v0.1.4216; `TestCodexKeptOnAHeldAccountShowsIt`). On a model of magpie's it is taken over like any other (`outOn`): keeping the sign-in says which account, not that magpie's models wait for it, and Always ChatGPT is the setting for that. Kept out of the takeover on every model, the app greyed Send on a routing group of Claude accounts with room till the ChatGPT account's reset (Yuzhou__Zhang on X, Stable v0.1.3960 to v0.1.4477; `TestCodexKeptOnAHeldAccountSendsMagpiesModel`). The loop's fresh read tells the sync when it changes what the sync last went by, not only when it differs from the loop's last answer (`noteCodexUsedUp`). The app then loses its ChatGPT state (durable threads, remote control: ChatGPT.app 26.1029 takes a `getAuthStatus` with no `authMethod` and `requiresOpenaiAuth` false as an "execution-storage" identity rather than a ChatGPT one, so its "Connect your phone" and the account's profile go too, and the Agents row's takeover note and its note at the reset name the phone connection among what is off, beside Keep on ChatGPT, which keeps it at the cost of a grey Send till the reset; Mugenrikka on X, `codex-app-out.test.cjs`, `codex-app-back.test.cjs`), so a window at 100% alone, which credits get past, doesn't move it (with no credits it does when the backend says `allowed` false, and only then: `codexAtLimit`. The app's composer gate greys Send on that alone, in ChatGPT.app 26.1029 as in 26.1021, and keeps a window of an allowed account at 1% or more, so allowed not said or allowed with a window at 100% is an account it still sends for. A used-up 5h window with the week open is held through it: the backend says allowed false there, as the real Team reply in testdata does with its 5h at 100% and its week at 63%; xiaoq6285 on Discord) (`codex.out` marks the move, and Sync undoes it once the account has room). The same holds on one of Codex's own models joined beside the sign-in (MasterYi on Discord: the Codex app greyed Send for every model on a used-up account): Sync makes magpie the provider on that model as magpie serves it (`codexOwnViaMagpie`, `codex/<model>`), keeps the model picked in `codex.out_own`, and once the account has room puts Codex back joined on it; a model the user picked meanwhile stays theirs. With no ChatGPT account in magpie to serve it, Codex is left as it is (`TestCodexOwnModelGoesThroughMagpieWhileUsedUp`, `TestCodexOwnModelKeptOnChatGPT`). Where magpie would serve that model on the same used-up account alone (no fallback on the Codex subscription and no other ChatGPT account not known out: `provider.CodexServesWhileOut` false), every turn on it would be refused too, but the Codex app greys Send for every model while the account is out, so keeping the account's menu costs a grey Send (shamen, chenhan and xiaoq6285 on Discord). Sync then makes magpie the provider on a stand-in model of magpie's that is on no ChatGPT account (`codexOtherModel`, kept in `codex.out_stand` beside `codex.out_own`), once per held/unheld transition: on the stand-in the model is magpie's, so the branch isn't met again and a steady held state writes nothing and ends no app-server. At the reset Codex is put back joined on its own model; another model picked meanwhile stays theirs (the stand-in itself picked can't be told from staying on it, and gives way to the own model). This reverses f37742e14, which left Codex on its sign-in to keep the account's menu and usage (the app-server restarts it cost, #4550, are the two the takeover makes). With nothing else in magpie to offer (no stand-in) Codex stays on its sign-in, as no takeover could send (`TestCodexOwnModelOneSpentAccountStaysOnItsSignIn`, `TestCodexOwnModelOneSpentAccountTakenOverForOtherModels`, `TestCodexServesWhileOut`). The account is read again at once when a reply says it may be out (a `usage_limit_reached` rest, or an `x-codex-*` window heard at 100%; `provider.CodexMayBeUsedUp`, at most every 20s, the active account only), not only on the five-minute look. A turn relayed to Codex's own sign-in, the one account on (`codexUpstreamOn` with no account, the gateway's `codexRelayedAccount`), is heard the same way: its `x-codex-*` windows and `codex.rate_limits` event kept as the sign-in's usage (`heardCodexLimits`), and a `usage_limit_reached` refusal reading it again. Before, only turns served through magpie's accounts were, so with one account magpie learned the account was out only at the next look, minutes on, and the Codex app kept Send greyed until it was restarted (unsplashz on Discord; `TestCodexUsedUpRelayedAsksAtOnce`, `TestCodexRelayedWindowsHeard`). A Codex started before magpie became its provider keeps sending its own model's turns to its built-in provider; while the sign-in is known out (`provider.CodexUsedUpKnown`) and the request signs as it, those go through routing as `codex/<model>` (`codexAccounts`), as a restarted Codex's do (`TestCodexHeldSignInServedWithoutRestart`). The Codex app greys Send for every model, magpie's too, while its `authMethod` is `chatgpt` and its rate limit says not allowed (its composer's gate in ChatGPT.app 26.1013), and reads `authMethod` from its app-server's `account/read` only as the app-server starts; with magpie the provider (`requires_openai_auth` false) that answers no account, so the gate lifts. So the gateway process restarts the app's own app-server each time magpie becomes Codex's provider for the used-up account (`Agent.AppOut`) and again when Codex is put back on the account after its reset, and likewise whenever what the app-server reads as it starts and magpie writes changes, which is where its requests go (`model_provider`, `openai_base_url` and the magpie table's `base_url`, and its `requires_openai_auth` while that table is Codex's `model_provider`: beside the sign-in the app-server reads the built-in provider's account, so the key following the account out and back is nothing it reads; `codexAppRoute`, through the `provider.CodexAppRoute` hook): a Disconnect, a Connect, failover written or taken out. The model list is not part of it: neither `model_catalog_json` nor what the catalog holds. The catalog follows magpie's names and the effort new sessions start at, which the Codex app saves on each pick, and the ChatGPT app takes an ended app-server as a crash and relaunches, so a route that hashed the catalog (from lucis0116 on X until #4550) ended the app every few minutes (indekkusu141209 on X). A new list is read at the app's next launch or on the Agents row's Restart (`StaleCopies`) A list that drops a model and has it back at the next fetch, the same list in another order, and a catalog read half-written leave the route as it was (`TestCodexEffortPickKeepsTheAppRunning`, `TestCodexAppRouteIgnoresARename`, `TestCodexAppRouteKeepsThroughListFlaps`). Before this an app-server started while Codex was connected kept sending to the gateway after Disconnect until the app was restarted (JiangLiuer222 on X). At the watcher's first look only a used-up account's app-servers are ended, since what the others read before magpie started isn't known. What magpie changes by itself that the app works without waits for the user, though, unless they ticked Restart the Codex app when magpie switches its account back (`Provider.RestartApp`, `provider/restartapp`, off by default, this computer's own like KeepLogin): its switch back once the account it moved off has room (`SwitchWhenSpent` → `switchLoginBy(…, true)`, `codexApp.auto`) and giving Codex its account back at the reset. A switch the user makes between accounts with room waits too: the app keeps its sidebar projects per ChatGPT identity, so a restart onto the new account showed none and every thread under Recent (Michael25651150 and ykj5353 on X, `TestCodexAppLeftRunningForMagpiesOwnChanges`). Those leave the app-server running, log why, and the switch notice's Restart is the way to follow; a user's switch off a used-up account (`codexAppSpentSwitch`), a Connect, a Disconnect and failover written or taken out still restart it, and so does the takeover turned off by the user rather than ended by the reset: its sign-in set to Always ChatGPT (the takeover note's Keep on ChatGPT) or Codex disconnected while magpie stood in (`Agent.AppOutOff` through `provider.CodexTakeoverOff`, asked only as `out` goes false). The app-server the takeover started answers `account/read` with no account, so the app kept its ChatGPT projects and chats hidden after the user turned the takeover off to have them back, and the Windows app has no Restart of its own (Herzz____ on X, `TestCodexAppRestartedWhenTheTakeoverIsTurnedOff`). So does whatever leaves the app-server on a used-up account, tick or not: the takeover in, the first look on one, and magpie's switch off one (`needed` in `codexAppStep`), since the app greys Send there and reads the account only as its app-server starts, so with the tick off a takeover at the limit left Send grey and the fallback unreachable (v0.1.2826 to its fix). An app-server left running on the account magpie switched Codex back off is restarted too once that account is read held (`restartCodexAppLeftOnSpent`, on each full look of `KeepOnAnAccountWithRoom`, once per app-server left): it keeps the account it started on (`CodexAppStale`), so when that ran out the app greyed Send for every model while the account Codex is signed in to had room and nothing else read the old one (nb5p on Discord: B first in magpie, the app still on A; `TestCodexAppLeftOnASpentAccountIsRestarted`). atom0964 on Discord had both sign-in ticks off and the ChatGPT app relaunched at every switch between two Plus accounts (`TestCodexAppLeftRunningForMagpiesOwnChanges`, `TestCodexAppFirstLookOnAUsedUpAccountRestarts`, `restart-app.test.cjs`). It runs on every system (`KeepCodexAppOnItsProvider`, every 3s; Ethereal499 and Isdavexxx on X, MasterYi on Discord, #540: the earlier once-only reopen ran on macOS from the GUI process only, so Windows, Linux, a GUI-less magpie and the switch back stayed greyed). It ends only app-servers on magpie's Codex home (`codexAppHomeIs`: the process's `CODEX_HOME`, else `HOME/.codex`, read by `proc.EnvOf`; Windows can't tell and counts every one), only once no Codex request is in flight through the gateway nor ended in the last 10s (`Server.CodexBusy`) and no session under the Codex home has a turn started and not ended (`codexTurnOpen`), and with a clean exit (`proc.End`: SIGTERM, `TerminateProcess` with code 0), since the app shows any other exit as a crash. Each end is logged with what made the app-server stale: the account switched, the route changed, or the used-up takeover (`codex: ended the Codex app's app-server [pid] for the app to start another: <why>`), so a crash a user reports can be put down to one of them (#4550, `TestCodexAppEndSaysWhy`). The app starts another app-server at once and keeps its window, threads and drafts (tried in the real app in a sandbox `CODEX_HOME`, both ways). An app-server that outlives three ends, or may not be ended, leaves the row saying to quit and reopen the app (`CodexAppStuck`). An ended app-server's pid gone doesn't mean the app has another: the Windows app (MSIX `OpenAI.Codex`, stdio) starts one only once the old one's stdout closes, and a child it left (an MCP server, a tool command) holds that pipe open, so the app answered "Codex app-server process is not available" until it was restarted (蛋仔 on Discord). The watcher waits `codexAppBackWait` (30s) for another app-server; when none came and the app is still open (`CodexAppOpen`), it quits and opens the app as the Agents row's Restart does (`CodexAppReopen`, Windows only), else the row says to (`CodexAppStuck`). `RestartCodexApp`, uninstall's `RestartCodexAppWhenIdle` and the switch notice's Restart (`RestartSwitchedCodexApp`) wait for it the same way and reopen or say so alike, and `recheckLeft` keeps the record while the app is open with no app-server. A signed-in ChatGPT app (26.1021) can still fail on the app-server it starts next ("Hosted AppServerManager identity is not ready") and show "ChatGPT hit a snag" until it is quit and opened again (ysm119 on Discord, #4550), a fault in the app the clean end can't avoid. So for `codexAppCrashWait` (60s) after each of these ends ([`codex_app_crash.go`](../../internal/provider/codex_app_crash.go)) the app's own logs are read (`CodexAppCrashed`, [`agent/codex_app_crash.go`](../../internal/agent/codex_app_crash.go): `~/Library/Logs/com.openai.codex`, `%LOCALAPPDATA%\Codex\Logs` and the Store package's, `$XDG_STATE_HOME/codex/logs`) for a whole `fatal_error_broadcasted` line stamped after the end. When the page shows and no request has gone through magpie or been in flight since, and no Codex turn has opened since, the app is quit and opened once (`CodexAppRelaunch`: ⌘Q's quit and `open` on macOS, never forced, ChatGPT.app by its bundle id only; `CodexAppReopen` on Windows), but after an end for a used-up account (a switch off one, or the takeover in: `crashSpent`) at once, and after any other end only with Restart the Codex app ticked (`codexRestartsApp`). The app was greyed on the used-up account already and the page is all its window shows, so RealZeroP27 on X (switch only, "只能通过手动重启 codex 解决", `TestCodexAppReopenedAfterASpentEndUnasked`) was left with a window only a quit clears; unasked, a quit of a working app read as magpie force-restarting it (Michael25651150 on X, `TestCodexAppNotQuitUnasked`, an end for a route change). The tick also gates the Windows reopen when no app-server came back (`codexAppGotNone`). The app-server's own restart at the takeover isn't gated: the app reads its account only as its app-server starts, so without it Send stays grey on the used-up account. Where the tick is off or that can't be done (Linux, an app that didn't quit) the Agents row says to quit and reopen it (`CodexAppSnagged`, `appSnag`) until the app-servers seen then are gone or the app is closed. Logs that can't be read reopen nothing (`TestCodexAppReopenedWhenItShowsItsErrorPage`, `TestCodexAppInUseAfterItsErrorPageIsLeft`, `TestCodexAppCrashedReadsItsOwnLogs`, `TestCodexAppRelaunchOnlyTheCodexApp`, `codex-app-snag.test.cjs`). A turn left open in Codex's sessions holds the restart for up to `codexTurnWindow` (30m), except where the app-server is on a used-up account: after a switch off one (`SwitchWhenSpent` → `codexAppSpentSwitch`, or a switch by hand off an account last read held, `codexHeldKnown` in `noteCodexSwitch`) and when magpie becomes Codex's provider for one (`codexAppStep`'s `into`; xiaoq6285 on Discord: quota out, then another account or provider picked, and Send stayed grey; `TestCodexAppServerRestartedPastATurnStuckWhenMagpieTakesOver`, `TestCodexHandSwitchOffAHeldAccountIsSpent`). There a turn that has written no session file and sent nothing through magpie for `codexTurnStuckAfter` (2m) counts stuck and the app-server is restarted past it, since its next request would be refused on that account (蛋仔 on Discord: quota ran out mid-task and the app hung till restarted; `TestCodexAppServerRestartedPastATurnStuckOnTheSpentAccount`). An account switch restarts nothing, and neither the app nor the background daemon is said to be left on the old account (`CodexAppStale`, `CodexDaemonStale`, the CLI's switch line), while the provider Codex's config.toml names takes no ChatGPT account (`provider.CodexNoAccount`, `codexNoAccount` in [`agents.go`](../../internal/agent/agents.go)): a top-level `model_provider` other than `openai` whose `[model_providers]` table doesn't say `requires_openai_auth = true`, such as magpie's with the user's own `false` (danzi002 on Discord). Codex then sends the table's key and its app-server reads no account (codex-rs `account_state`, `resolve_provider_auth`); tried with codex-cli 0.165.0 in a sandbox `CODEX_HOME`: `account/read` and `getAuthStatus` said no account before and after auth.json was switched, and `codex exec` sent `Bearer` the table's key on both accounts. A route change still restarts it, and so does a switch under a profile, the built-in provider, a provider with no table or a config that can't be read (`TestCodexNoAccountSwitchRestartsNothing`, `TestCodexNoAccountOfEachConfig`, `TestCodexNoAccountFollowsRequiresOpenAIAuth`). Until the reset the app's ChatGPT side is off (cloud tasks, its usage meter, Log out); the Agents row says so with the reset's time (`appOut` in `/api/state`, `CodexOutUntil`), and it all comes back at the reset. While the active account is held or a window is at 90% or more, its usage is read every minute rather than every five (`codexLookEvery`). `TestCodexAppServerRestartedEachWay`, `TestCodexAppServerRestartedOnDisconnect`, `TestCodexAppRouteFollowsConnectAndDisconnect`, `TestCodexEffortPickKeepsTheAppRunning`, `TestCodexAppRouteIgnoresARename`, `TestCodexAppServerUnknown`, `TestCodexAppServerStuck`, `TestCodexAppServersOnHome`, `TestCodexTurnOpen`, `TestCodexBusy`, `codex-app-out.test.cjs`.
-- The Codex app's picker beside the sign-in reads `magpie-desktop-models.json` (`deskList`): the ChatGPT backend's list with magpie's models after it (`gateway.CodexDesktopCatalog`). A backend this machine cannot reach (a firewall; not_4O4 on X, Windows) gave no list and the file was never written, GPT alone in the picker. After a failed ask with no list from before, Codex's own `models_cache.json` stands in (`codexDesk.failed`); the real list replaces it when the backend answers. With no cache the file stays as it was, and a 502 after a revoked sign-in is still no answer. The app-server reads `model_catalog_json` only as it starts (codex-rs `model_catalog.rs` reloads on an account change alone), and the app keeps one app-server for all its windows, running from login on Windows. A list named after it started never reached the picker, in a new window or a new project either (not_4O4 on X, again after the list was known). So `deskList` stashes when it names the key (`codex.desk_at`, `DeskAt`), and keeps that time until it takes the list out as not wanted: a model picked in magpie or a reset takes the key out and names it again in one change, and a new time each pick would restart the app each pick. Then `codexAppDeskStep` restarts the app's app-servers that started before that, once for each naming, as for a Connect and with `RestartApp` off too. One whose start can't be read is left, and so is the takeover's: the reset names the list again as it ends, and that app is left for the user (#4550). A new list in a named file still waits for the app's next launch. A key named by a magpie from before `desk_at` was kept has no time, and nothing is restarted for it (`TestCodexAppRestartedForTheListNamed`, `TestCodexDesktopListNamedAt`).
+- The Codex app's picker beside the sign-in reads `magpie-desktop-models.json` (`deskList`): the ChatGPT backend's list with magpie's models after it (`gateway.CodexDesktopCatalog`). A backend this machine cannot reach (a firewall; not_4O4 on X, Windows) gave no list and the file was never written, GPT alone in the picker. After a failed ask with no list from before, Codex's own `models_cache.json` stands in (`codexDesk.failed`); the real list replaces it when the backend answers. With no cache the file stays as it was, and a 502 after a revoked sign-in is still no answer. A Codex Home moved to another volume and left as a symlink spells one catalog two ways; the comparison resolves the folders' symlinks (a missing file riding on its resolved folder), so the list magpie named by either spelling is magpie's own and is taken out whole when it is not wanted (#7014). The app-server reads `model_catalog_json` only as it starts (codex-rs `model_catalog.rs` reloads on an account change alone), and the app keeps one app-server for all its windows, running from login on Windows. A list named after it started never reached the picker, in a new window or a new project either (not_4O4 on X, again after the list was known). So `deskList` stashes when it names the key (`codex.desk_at`, `DeskAt`), and keeps that time until it takes the list out as not wanted: a model picked in magpie or a reset takes the key out and names it again in one change, and a new time each pick would restart the app each pick. Then `codexAppDeskStep` restarts the app's app-servers that started before that, once for each naming, as for a Connect and with `RestartApp` off too. One whose start can't be read is left, and so is the takeover's: the reset names the list again as it ends, and that app is left for the user (#4550). A new list in a named file still waits for the app's next launch. A key named by a magpie from before `desk_at` was kept has no time, and nothing is restarted for it (`TestCodexAppRestartedForTheListNamed`, `TestCodexDesktopListNamedAt`).
 
 - The Codex app (ChatGPT.app 26.1103 and on) keeps its sidebar's projects per ChatGPT identity in `$CODEX_HOME/.codex-global-state.json`, under `electron-account-renderer-state-v1` (`{owner, inactive: {<hash>: {atoms, globals}}}`, the hash the sha256 hex of `JSON.stringify([chatgpt_user_id, chatgpt_account_id])`): on an account change it parks the old identity's account-scoped globals and loads the new one's, so a switch to an account that never had the app open showed no projects (Michael25651150 on X; #5497, #5602, #5702, #5874). The app reads the file only as it starts and writes its memory over it, so magpie writes it only while the app is closed ([`codex_projects.go`](../../internal/provider/codex_projects.go)): `codexProjectsStep` in `codexAppStep`, once the file, auth.json or logins.json changed (at most every 30s while the app may be open, since `CodexAppOpen` lists processes), and `CodexAppClosed` between the quit and the open of every reopen (`appQuitDone` in [`apprestart.go`](../../internal/agent/apprestart.go)). Every identity, those of auth.json and magpie's saved Codex logins and those the file has, gets one list (`shareCodexProjects`, Michael25651150 on X again): each identity's `local-projects` together, the signed-in identity's copy first, with the ties the other project keys (`codexProjectKeys`) have to them, one or two levels down (`codexGraft`). A folder is one project (`codexRootKey`): the app gives a project a random id on each account, so a project of a folder an identity has already is that one, its threads renamed to it. What the user removed is remembered: `codex-projects.json` beside logins.json keeps each identity's project ids and folders as the last look left them, and a project a look saw on an identity that the next doesn't have was removed there, so it goes from every identity with every tie to it (`codexPrune`), as do other projects of its folders, unless the user added that project or folder again on some identity since. A record that can't be read or parsed means what was removed is unknown, and nothing is written. The first look, with no record, removes nothing. A ChatGPT project's mirror (`g-p-` ids, and every tie to one) isn't shared, and a backing naming another account is dropped (`projectFor`), since the app refuses to act on a project "belongs to a different ChatGPT account". The record is written only after the state file is, so a look the app's own start overtook is taken again. A file without the key (an older app) or that doesn't parse is left as it is; before its first write the file as it was is kept beside it (`.magpie-before-projects`). Projects added or removed while the app runs reach the other accounts once it is closed. With no account (the takeover, `requires_openai_auth` false) the app shows no projects by its own rule, and they come back with the account (`TestCodexProjectsFollowASwitch`, `TestCodexProjectsShared`, `TestCodexProjectsRemovalRemembered`, `TestCodexProjectsRecordUnreadable`, `TestCodexProjectsUnknownFileLeft`, `TestCodexProjectsStepWaitsForTheAppToClose`).
 - Moving a field from one of magpie's models to another (the agent's own picker) is not drift. Moving it off magpie is.
diff --git a/internal/agent/codex.go b/internal/agent/codex.go
index 8669b4fe8..49dcb9be7 100644
--- a/internal/agent/codex.go
+++ b/internal/agent/codex.go
@@ -91,6 +91,21 @@ func codexStandIn(path string) string {
 
 func codex(home string) *Agent { return codexIn(here(home)) }
 
+// resolveRidingMissing resolves p through the symlinks its folders hold; a
+// missing file rides on its resolved folder, since what this compares may
+// be gone exactly while it is being decided about (#7014).
+func resolveRidingMissing(p string) string {
+	p = filepath.Clean(p)
+	if r, err := filepath.EvalSymlinks(p); err == nil {
+		return r
+	}
+	dir, base := filepath.Split(p)
+	if r, err := filepath.EvalSymlinks(filepath.Clean(dir)); err == nil {
+		return filepath.Join(r, base)
+	}
+	return p
+}
+
 // The two notices magpie's multi-agent V1 setting (#141) can carry: Codex's
 // own features.multi_agent_v2 is on in the config magpie routes and takes the
 // V1 over, or magpie couldn't read that config to tell. magpie writes nothing
@@ -459,7 +474,16 @@ func codexIn(at place) *Agent {
 		if !filepath.IsAbs(c) {
 			c = filepath.Join(dir, c)
 		}
-		return filepath.Clean(c) == filepath.Clean(deskPath)
+		if filepath.Clean(c) == filepath.Clean(deskPath) {
+			return true
+		}
+		// A symlinked Codex Home makes one catalog spell two ways: the config
+		// names the alias while CODEX_HOME has since said the resolved folder
+		// deskPath is under, and the alias stood first, so this comparison
+		// decides whether the file goes (#7014). Compare resolved, a missing
+		// file riding on its folder's resolution — gone is exactly the state
+		// this owns.
+		return resolveRidingMissing(c) == resolveRidingMissing(deskPath)
 	}
 	deskGone := func() bool {
 		_, err := os.Stat(deskPath)
diff --git a/internal/agent/codex_desktop_test.go b/internal/agent/codex_desktop_test.go
index c3f454ccb..ce8213a29 100644
--- a/internal/agent/codex_desktop_test.go
+++ b/internal/agent/codex_desktop_test.go
@@ -271,3 +271,90 @@ func TestCodexDesktopListNamedAt(t *testing.T) {
 		t.Fatalf("named again at %v, want after %v\n%s", again, at, read())
 	}
 }
+
+// A symlinked Codex Home makes one catalog spell two ways: the config may
+// name the alias (/Users/x/.codex/…) while CODEX_HOME names the resolved
+// folder, and magpie's deskPath is the resolved one (#7014). deskList took
+// its own file for the user's then — the file went, the config kept naming
+// it, and Codex refused its config with it. The ownership comparison
+// resolves the symlinks their folders hold, a missing file riding on its
+// resolved folder, so at every stage the key names an existing catalog or
+// is gone.
+func TestCodexDesktopListSymlinkedHome(t *testing.T) {
+	home, read := codexHome(t, `{"tokens":{"access_token":"x","id_token":"x.e30.x"}}`, "model = \"gpt-5.5\"\n")
+	ext := filepath.Join(t.TempDir(), "external-codex-home")
+	if err := os.Rename(filepath.Join(home, ".codex"), ext); err != nil {
+		t.Fatal(err)
+	}
+	if err := os.Symlink(ext, filepath.Join(home, ".codex")); err != nil {
+		t.Fatal(err)
+	}
+	// CODEX_HOME names the resolved folder, as the reporter's launchd did
+	t.Setenv("CODEX_HOME", ext)
+	app := true
+	codexAppReads(t, &app)
+	list := `{"models":[{"slug":"gpt-6-sol"}]}`
+	deskListIs(t, &list)
+
+	// joined beside the sign-in, magpie names its list by the resolved
+	// folder. An older magpie, before CODEX_HOME said the external volume,
+	// had named it by the alias; the config still says the alias, as the
+	// reporter's did across the update
+	cx := codex(home)
+	if ok, err := cx.Join(); err != nil || !ok {
+		t.Fatalf("join: %v %v", ok, err)
+	}
+	deskRef := ext + "/magpie-desktop-models.json"
+	alias := filepath.Join(home, ".codex", "magpie-desktop-models.json")
+	if b, err := os.ReadFile(deskRef); err != nil || !strings.Contains(string(b), "gpt-6-sol") {
+		t.Fatalf("precondition: the desk list joined: %q %v", b, err)
+	}
+	cfg := strings.Replace(read(), deskRef, alias, 1)
+	if !strings.Contains(cfg, "model_catalog_json = \""+alias+"\"") {
+		t.Fatalf("the alias naming did not replace the resolved one:\n%s", cfg)
+	}
+	if err := os.WriteFile(filepath.Join(ext, "config.toml"), []byte(cfg), 0o644); err != nil {
+		t.Fatal(err)
+	}
+	if b, err := os.ReadFile(alias); err != nil || string(b) != list {
+		t.Fatalf("precondition: the catalog readable by its alias: %q %v", b, err)
+	}
+
+	// a sync with the config naming the alias: the catalog is magpie's own
+	// however it is spelled — it stands, and the key still names it
+	if err := cx.Sync(); err != nil {
+		t.Fatal(err)
+	}
+	if b, err := os.ReadFile(alias); err != nil || string(b) != list {
+		t.Fatalf("the catalog named by its alias was taken for the user's and removed: %q %v", b, err)
+	}
+	if cfg := read(); !strings.Contains(cfg, "magpie-desktop-models.json") {
+		t.Fatalf("the key naming it went:\n%s", cfg)
+	}
+
+	// the app reader gone: the list is magpie's own, taken out whole — the
+	// key and the file, no reference left dangling
+	app = false
+	if err := cx.Sync(); err != nil {
+		t.Fatal(err)
+	}
+	if cfg := read(); strings.Contains(cfg, "model_catalog_json") {
+		t.Fatalf("not wanted, the key stays:\n%s", cfg)
+	}
+	if _, err := os.Stat(alias); !os.IsNotExist(err) {
+		t.Fatalf("not wanted, the file stays: %v", err)
+	}
+
+	// back again: named anew, the file written to the resolved folder and
+	// seen through the alias
+	app = true
+	if err := cx.Sync(); err != nil {
+		t.Fatal(err)
+	}
+	if b, err := os.ReadFile(alias); err != nil || string(b) != list {
+		t.Fatalf("back: %q %v", b, err)
+	}
+	if cfg := read(); !strings.Contains(cfg, "magpie-desktop-models.json") {
+		t.Fatalf("back, the key:\n%s", cfg)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>
