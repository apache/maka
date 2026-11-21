First: I put a `take` here on Nov 5 and then went quiet — sorry about that. I picked this back up today and walked all three symptoms against current main (`f6c882ad7`) and the plugin's current `@magpie-community/opencode-trae-auth` **0.2.34** (published today; the models hook is the same shape as the 0.2.30 you were on). Conclusion up front: I have no patch for magpie itself, because the fixable roots are in the plugin — which is the move you already suggested in your last paragraph. Two concrete plugin-side fixes below.

### 1. The 20s timeout is already protected, on magpie's side

`pluginListWait` (20s) is handed to the plugin host as `listMillis` (internal/plugin/host.js:3540), and when a models hook overruns it the host throws a `Late` error, marks the provider `fellBack` (host.js:2290), and logs exactly the line you saw at 21:32:37 (host.js:2294). A fallen-back list never overwrites the last good one: `keepListed` (internal/plugin/providers.go:521) replaces it with the list the plugin told before, the relist comparison skips fallen-back providers (internal/provider/plugin_relist.go:87), and picks that were set aside come back on their own once the list has them again, with the loop re-asking after 5 minutes instead of an hour (`relistSoon`, plugin_relist.go:33). Your "keep the last successful list and retry" already exists for every failure magpie can see. On tip `f6c882ad7` the guarding tests pass here: `TestStuckModelListHoldsNoOther`, `TestFallenBackListSaysWhy`, `TestLapsedFirstAccountKeepsTheProvidersList` (internal/plugin), and `TestPluginPicksComeBackWithTheirList`, `TestEveryPickDelistedServesNone`, `TestPluginsListedAgainWhileRunning` (internal/provider).

### 2. Why picks were dropped anyway: the plugin told a short list as its own

The host only treats a list as a fallback when the hook returns the very list it was given after a failed vendor read, or returns an object marked `Symbol.for("magpie.fellBack")` (host.js:2263). Anything else is an authoritative list. The trae plugin's models hook (0.2.34 index.mjs:3962) returns a **fresh object** built from whatever its vendor reads came back with (index.mjs:3973), and only falls back to the given defaults when the read is completely empty (index.mjs:3971). So when Trae answers 200 but its `config_info_list` data comes back missing entries — the flakiness behind "sometimes 3 models, sometimes 90" — the partial list reaches magpie looking authoritative, and the hourly relist (first pass one minute after start: 21:32:37 + 59s = your 21:33:36 drop) sets the missing models' picks aside. A timed-out read **cannot** drop picks (it is marked fell back); only an unmarked short list can. That is why your three picked models left while the last good list was still on disk.

The set-aside itself is deliberate — it exists so a vendor that genuinely delists a model (the bug this machinery was built for) does not leave a dead pick routed forever, and it is reversible: picks return automatically once listed again. The fix is not to make magpie distrust short lists (it cannot tell a flaky read from a real delisting), but for the plugin to mark a read that came up short: comparing the read against its own previous read (the plugin keeps that state in `readAt`) and setting `Symbol.for("magpie.fellBack")` on the returned object when it shrank would make magpie keep the last good list and say why.

### 3. The 502 (code 4001) that takes minutes

Trae rejects the params mid-flight (the request is accepted, then the stream carries the error), so the plugin's request loop tries every function for the model (index.mjs:4085/4093/4101, `wrongFunction` = 4001/4023/1005), and when all of them fail it wraps the last one as **502** — the two mid-flight paths hardcode 502 (index.mjs:4093, index.mjs:4101) before `failure` falls back to 502 for sub-400 statuses (index.mjs:2860). magpie rightly reads a 502 as "member busy, may recover" (`busyStatus`, internal/gateway/patience.go:111) and rides its replan ladder — your 2m07s and 4m24s are those windows, not one slow call. The same model then working alone at 200 in 1–4s matches this: the params the plugin built were wrong while its list/entry state was stale, and healed when the list recovered.

The plugin-side shape that would fail fast without losing failover: when every function fails with `wrongFunction`, answer 400 with the model named in unserved words (e.g. `model "x" is not available for this account (code 4001)`). magpie classifies 4xx + unserved words as model-refused (internal/gateway/fallback.go:1651, words at internal/provider/plugins.go:806) — the model rests alone, the group's other members are asked immediately, and the agent gets the error at once instead of after minutes.

### To @malhijohn79-sketch

This thread is about Trae CN's model list coming back short/partial and picks being dropped after a refresh — not a cache counter reading 0, which I can't speak to. If your case is the list going short, everything above (and the fellBack mark fix) is the relevant chain.

### Suggested next step

Per your own last paragraph: this belongs in magpie-community/plugins (package `opencode-trae-auth`). The two changes: (a) mark shrunken reads with `Symbol.for("magpie.fellBack")` in the models hook; (b) surface exhausted `wrongFunction` as a 400 + unserved-words answer instead of 502. Happy to carry either over there if useful.

---

**Checked, for the record**: upstream `f6c882ad7` — the tests named in (1) pass; `git log` since Nov 1 touches neither the relist drop nor the host's fellBack contract; the plugin's 0.2.31–0.2.34 do not change the models-hook return shape (diffed 0.2.30 vs 0.2.34). **Not verified**: no Trae CN account here, so the plugin-side reading is source-level; the exact shape of the short list at 21:33:36 (87/90 vs fewer) is inferred from your log line, since only an unmarked list can drop picks; the 2m/4m windows are read as the patience ladder from the code, not measured on your machine.

**Attribution**: written with GLM-5.3-Flash (ZCode); the source readings above are mine to defend.
