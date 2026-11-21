Verdict: this one is real, well measured, and — after tracing every hop in this repo — it lands on a design decision, not a bug magpie can patch on its own. I took it to try; here is the full source-level case for why I am not attaching a patch, and what the two real paths are.

## The adoption chain, verified at `e3ab7f3bf` (upstream/main, 2026-11-10)

What you measured is exactly what the code does. One number travels this path:

1. The plugin maps Trae's mode budget onto the field whose contract is "the context window". `@magpie-community/opencode-trae-auth@0.2.33` (npm, latest — same version you re-checked; its `modelOf` is where you looked), `index.mjs:3614`:

   ```js
   // context_window_tokens: dev is what a request gets, max only in Max mode
   const ctx = Number(m.context_window_tokens?.dev ?? m.context_window_size?.max?.[0] ?? ... ) || was.limit?.context || MODEL.limit.context
   ```

   The Max-mode window is deliberately a separate listing (`maxModel`, `index.mjs:2897`; `const MAX = "-max"`, `:2909` — "deepseek-v4.1-flash-max is deepseek-v4.1-flash in Max mode"). So `dev`-as-`limit.context` is the plugin's own documented design, not a slip.

2. magpie's host reads only the OpenCode shape — `internal/plugin/host.js:2613` maps `context`, `input`, `output` from `limit.*` and nothing else. `context_window_tokens` never leaves the plugin; magpie core cannot see that the number was a mode budget.

3. `pluginCatalog` (`internal/provider/plugins.go:335`) adopts it with the one clamp core has (the #1286 prompt-cap rule): the published window is `min(Window(limit.input), Window(limit.context))`. Note this clamp cannot express "budget vs capability" in either arrangement — whichever field carries the smaller dev value wins, so no plugin can smuggle the real ceiling through `limit.input` either.

4. `ListedWindow` (`internal/provider/models.go:3672`) takes the vendor's word over models.dev's; `WindowOf` (:3693) puts the user's word over both; `entryFor` (:3449) freezes it into `Entry.Context`.

5. Every publication point reads that one `Entry.Context` — which is why a local fix anywhere downstream is a hole, not a fix.

## Why no core-side patch survives contact with the design

I checked each candidate at the shared root (the adoption contract) and each fails:

- **Prefer models.dev / take the max of sources.** Overstating a window is the dangerous direction: agents send past what is actually served and hard-fail. That is exactly the #4584 WorkBuddy shape (declared 1M, served 100K). Understating compacts early; overstating breaks requests — the vendor's-word-wins rule is load-bearing, not accidental. (WorkBuddy's output-limit half was likewise fixed by making the *plugin* declare the truth, plus core pinning the minimum plugin version — `0f04dca6e`.)
- **Special-case trae-cn in core.** Plugin logic in core, and host.js doesn't even carry the raw fields to do it.
- **Max with the sibling `-max` entry.** Erases the plugin's dev/max distinction: the two entries route differently (`-max` asks Trae's `__max` model, with its own output ceiling). It would also misdeclare `-max` itself, which you measured to understate too (1,000,000 is Trae's own list's `context_window_tokens.max` — magpie has no better number than the vendor's list here either).
- **A LeastWindow-style numeric filter.** `Window`/`LeastWindow = 2048` (`internal/catalog/catalog.go:538`) filters noise like the 512 listings; 116000 is indistinguishable from an honest 116K window by value.

**Sibling scan (every point that tells the window out, all reading the one `Entry.Context`):** `/v1/models` `modelObject` (`internal/gateway/gateway.go:1376`, `context_window` = `context_length` = `max_input_tokens`), the Catwalk-shape list (:1473), Ollama's `details` (`internal/gateway/ollama.go:160`), the agent writers' configs (dsh/Pi/OpenCode/Crush/Command Code — your comment-5 correction is right: they consume the catalog, and this chain is the shared point for both mechanisms), the GUI's `providers.json` (`Context`/`Listed`, `internal/gui/providers.go`), the CLI. All consistent; none locally fixable.

Also confirmed: the gateway does not enforce the number (`context_length_exceeded` at `gateway.go:10393` is a classification of *vendor* errors, never magpie's own check), so your evidence 5 stands — the value is purely declarative, which is what makes the contract question, not a guard question, the right frame.

## What the two real paths are

1. **The plugin carries the real window.** Precedent is exact: #4584/plugins#561 (closed) removed the WorkBuddy cap in the plugin; where wrong numbers were already in flight, core pinned a minimum plugin version (`0f04dca6e`). If the trae plugin mapped `context_window_tokens.max` (or the ceiling) into `limit.context` and kept `dev` as its own thing, magpie would publish the capability today with zero core changes — and your `-max` note shows the ceiling number itself has to come from Trae's list (the plugin can already read both).
2. **The protocol grows a budget field** (your #2889 shape): plugins then say "window X, normal-mode budget Y", core keeps `context_length` = capability and exposes the budget beside it. That is a plugin-protocol contract change every plugin can grow into — squarely @yetone's call, and I won't pre-empt it.

Until one lands, the user-side escape works and is asserted by `TestPluginModelWindow` (`internal/provider/plugin_context_test.go`): Model settings' window (`SetContext`) overrides what agents are told for that model or the whole provider, over the plugin's word — so today a user can set 1048576 and every writer follows.

## Responses to your points

- Env refresh, the withdrawn `-max`-billing line, the corrected routing rationale: all accepted as stated — nothing in the code contradicts them.
- Writers consume the catalog, not HTTP `/v1/models`: correct, and the chain above is the single shared source for both.
- Your option 1 (separate field) and option 2 (writers use capability) are the same fix seen from two sides: both need the plugin to say budget and capability apart, which the current protocol cannot express (the `min(input, context)` clamp in step 3 is why). Option 3 (document) lives in the plugin's README, where the dev semantics are already written; core docs describing one plugin's quirk would be noise.

## Verification status

- Source-level claims above: read at `e3ab7f3bf`, and `@magpie-community/opencode-trae-auth@0.2.33` unpacked from npm (`npm view` at posting: 0.2.33 latest).
- Your live probes (1M-token sends through the gateway, credits deltas): **NOT-RUNNABLE** here — they need a real Trae CN account; your measurements are internally consistent and match the code paths, so I take them as given and add only the source evidence.
- No patch attached, so no am/ablation row; the issue stays open for the contract decision. I'll leave it to you whether path 1 (plugin mapping) should move to magpie-community/plugins or whether you want to settle path 2 here.

Generated-by: GLM-5.3-Flash (ZCode)
