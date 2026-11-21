This post and its patch are written by an AI (GLM-5.3-Flash via ZCode) and authored by ggbdpq.

**What's wrong**

With a provider routing over several accounts (WorkBuddy, rotate), an account removed from it mid-day — here the third one, whose five tries all failed with `insufficient_quota` before the removal — stays on Routing › Accounts and keys for the rest of the day, saying "what's left not known yet" with its failed tries, and the fold heading keeps counting it: "3 accounts · 3 available" for a provider that serves two. Exactly as reported; the counts themselves are right, it is the listing that isn't.

**Root cause** — the report's reading, confirmed and one face added

Since #3351 the fold builds its map (`foldActs`) from two places, and neither checks that the account or key is still one of the provider's:

- the day's tallies the history read already carries — every key in `tallies` is seeded into the fold, so the removed account's day keeps it listed;
- and every request the gateway still keeps: each kept request's `order` names the seats routing weighed it over, so *any* request planned while the account was still configured re-creates its entry (a rotate group planned all three accounts into every order, tried or not). Filtering the seed alone would leave this second face listing the account until the kept window moves past the removal.

**The fix**

`/api/gateway/history`, on the live read the page already polls, now carries `serves` — what each provider serves now, named the way the tallies and the fold already name them: an account by its provider and its user in lower case, a key or the provider by its own id (a key's id alone when it is the only one, with its own when there are more — both forms kept, so entries planned under the multi-key naming still match after the user deletes down to one key; `provider.AccountIDs`, so a plugin's accounts are all there, the reporter's WorkBuddy included).

`foldActs` keeps its entries to those, live only; a day looked at keeps who it had — the day's list stays the day's truth. The list, the fold row's "{n} accounts · {n} available" and the sums all derive from the fold's map, so the dropped entry leaves all of them at once. No user-visible wording changed.

`routing: an account removed from its provider leaves the Accounts and keys fold (#5895)`, branch [`fix/5895-deleted-account-acts`](https://github.com/ggbdpq/magpie/tree/fix/5895-deleted-account-acts) on current main `db0f2f20d`:

```sh
git am https://github.com/ggbdpq/magpie/commit/7556ff8ffed31e6558b09a0c02cebf50dd3386a5.patch
```

sha256[:16] = `068c3aae24eface0` · `git am` into a clean tree at `db0f2f20d`: zero conflict, resulting tree identical to the branch.

**Reproduction and verification** (this machine, darwin/arm64)

| Check | Result |
| --- | --- |
| `routing-acts-removed.test.cjs` (new; the report's shape: three accounts over rotate, the third's five tries failed, then removed; `serves` names two) | red before the change — the removed account on the page, fold row "3 accounts · 3 available" (chromium and webkit); green after — gone from the list, two rows left, no fold row counting three, the others' counts still the day's tallies said |
| kept-window face pinned in the same test: both kept requests still weigh the removed account in their orders | covered by the same filter, same red→green |
| the fold family re-run after the change — `routing-day-tallies` (#3351's own), `routing-acts-idle`, `routing-acts-compact`, `routing-acts-calm`, `routing-keys-fold` (#1319's sums), `routing-group-fold` — chromium + webkit, all their languages | 144 tests, all green |
| `TestLiveHistoryServesWhatTheProvidersServeNow` (new, Go) | green: two keys on → `p`, `p#<k1>`, `p#<k2>`; the second key removed → its id off the list, the provider and the first key's stay; a day asked by name carries no `serves` (the day's fold is the day's) |
| `TestLiveHistoryTalliesTheWholeDay` (#3351), `TestDayTallies*` (gateway) | green, unchanged |
| `go build ./...`, `gofmt -l`, `node --check client.js` | clean |
| no WorkBuddy plugin or real plugin accounts on this machine | the fixture pins the report's shapes through the same endpoints the real page polls (`/api/gateway/trace`, `/api/gateway/history`) — the real-plugin run is the reporter's, and their logs already pin the wire shape |

**Ablation** (each mutation builds clean, so the red is semantic)

- the fold's keep-to-served filter taken out: the removed account back on the page, fold row "3 accounts · 3 available" — red on chromium; restored → green (both engines).
- the `serves` line taken out of the history read (with its builder): `TestLiveHistoryServesWhatTheProvidersServeNow` red (`serves []`); restored → green.

**Sibling scan**

- `tallies` has no reader but the fold's seed and the "over today's requests" note; `serves` rides the same read, so no other surface changes.
- the second propagation face (kept requests' orders) is covered by the same filter — a request that was planned over the removed account still shows it in the stage's replay of *that request*, which is the trace of what happened and stays.
- Usage page, `magpie usage`, the tray's figures: the day's usage history — a removed account's answered rows belong there by design (the report agrees: the counts are right).
- `magpie accounts --json` and the provider dialog: config — already right (verified in the report).
- the quota cards: `provider.Quotas` reads the accounts on now; a removed account is not read, nothing stale.
- the masking set (`noteAccounts`) intentionally gathers names from history too, so Hide accounts still hides a removed one's name on old requests — untouched.
- `gateway.DayTallies` has one Go reader, the live history read — now sharing it with `serves`.
- `2026-11-08..db0f2f20d` on `routing/client.js` and `gui/trace.go`: rules' hours/conditions/notes, Never-a-fallback, plan names, cache rate — none touch `foldActs`, the tallies or the history handler's live block; the branch is cut at `db0f2f20d`, so there is nothing to re-adjudicate.

Generated-by: GLM-5.3-Flash (ZCode)
