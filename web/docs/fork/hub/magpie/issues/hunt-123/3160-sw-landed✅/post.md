**Verdict: already fixed on current main**

@yiliang114's stale-while-revalidate suggestion from this very issue was implemented by @yetone in commit 09c0a844b, shipped in **v0.1.1528**. I re-verified this independently on the repo today rather than taking the comment at face value: `git merge-base --is-ancestor 09c0a844b upstream/main` passes, and the smallest `v0.1.*` tag containing the commit is v0.1.1528 (`git tag --contains 09c0a844b`, version-sorted). Upgrading to v0.1.1528 or anything newer picks up the fix.

**What landed** (commit 09c0a844b, "gui: the tray panel draws its last allowances at once and asks for them beside the state"):

1. **Storage memory** - the panel keeps the last-read allowances in the webview's own storage (`magpie.panelQuotas` in `localStorage`).
2. **Cards drawn at once** - on open it paints those kept cards immediately instead of skeleton cards, so with any previous record there is no skeleton screen anymore. First-ever open (no record yet) still shows skeletons, as @yetone stated.
3. **Refresh indicator** - each card's refresh button spins (`.quota-refresh.reading`) until the fresh read lands and replaces the old numbers in place.
4. **Request timeline moved earlier** - the first load now asks `/api/usage/quotas` beside `/api/state` instead of strictly after it (`panelQuotasNow`). @yetone's measured medians (sandbox, real deepseek account, playwright on the panel Allowances tab at 360px, 14 runs each, old vs new interleaved, DOMContentLoaded to cards drawn): Chromium 347ms to 160ms, WebKit **723ms to 211ms**.

The same commit carries a regression test, `internal/gui/tests/panel-quota-kept.test.cjs` (kept cards drawn at once; red on the old assets and red with the early ask removed by hand), and touches `app.js`, `app.css`, and `core_budget_test.go`.

**What the maintainer asked back**

@yetone kept the issue open on purpose, waiting for the reporter to confirm the effect. He listed what he could not test himself:

- end-to-end through the real tray icon click (his System Events scripting failed in the sandbox)
- subscription accounts (Codex/Claude; he measured with a deepseek account only)
- Windows and Linux webviews

So the confirmation duty sits with @yiliang114: upgrade to v0.1.1528+ (or build current main), reopen the panel's Allowances tab, and reply here whether the skeleton gap is gone on second and later opens. That reply is the natural close path for this issue.

**Evidence**

| Check | Result |
| --- | --- |
| Fix commit in main | `merge-base --is-ancestor 09c0a844b upstream/main` passes; main tip `f24829636` |
| First release with the fix | `v0.1.1528` (smallest `v0.1.*` tag containing the commit, `git tag --contains`) |
| Symbols alive at tip | `magpie.panelQuotas` read/write and `panelQuotasNow` in `app.js`; `.quota-refresh.reading` spin styles in `app.css` |
| Diff surface | `app.js` (+31), `app.css` (+11/-), `core_budget_test.go`, new `panel-quota-kept.test.cjs` (+88) |

AI use: analysis written with GLM-5.3-Flash (ZCode) from a code read of the repo; credit @yiliang114 (suggestion) + @yetone (fix).
