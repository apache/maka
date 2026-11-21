<!-- 发布稿 · #2591 评论 · 待用户读完 diff 当轮授权后发布
     发布前查重三步：gh pr list --search 2591；gh issue view 2591 重读评论；git fetch upstream 看主是否已修。
     推送：git -C <pr1> -c credential.helper='!gh auth git-credential' push fork fix/2591-sessions-cache
     发布后 GET 回读。 -->

The Sessions tab counted its tokens in and out alone, so with the Overview's
totals set to *With cache* (#2378) the same period read two ways: the tab's
tokens tile, the list rows, the projects and models bars and pickers, the day
chart and the top sessions left the cache out that the Overview counted — and
that the tile beside them names (148M read beside 7.3M in your screenshot).

This patch makes the tab read `usageTokens` wherever the Overview does. Its
tokens tile carries the same label pop-up and says the cache's count in its
line; a pick made there refreshes the tab it is on instead of the Overview.
The chart's day and week buckets carry the cache's counts now that their
value reads them. The top sessions, ranked by the backend without the cache,
are ranked again by the count shown. The default stays *without the cache*,
as #2378 left it; the per-session median and p90 stay counted in and out
(`Stats.Overview` ranks them); the Requests tab always counted every token.

Branch `fix/2591-sessions-cache` at ggbdpq/magpie (base `89521b03`, head
`1020b7b4`).

---
**Source**: reported here by n1majne3; the Sessions tab of the Usage page,
the sibling face of #2378's Overview switch.

**Red without the fix** (base `89521b03`): `BROWSER=chromium node --test
internal/gui/tests/sessions-cache-tokens.test.cjs` fails, en and zh alike:
```
AssertionError [ERR_ASSERTION]: the tile's tokens
'57.0K' !== '168K'
```
With the fix: ok (chromium and webkit, en and zh).

**Siblings**: the tab's token counts, `rg -n "input \+ |usageTokens\("
internal/gui/assets/plugins/usage/page.js` — changed: `sessTokens` (both
lists' rows through `sessSpent`), `spent` (the model and folder pickers),
the tokens tile, `sessSums` (the projects and models bars),
`renderSessChart` (`value`, `tip`, the bars' fill, the day and week
buckets), `sessCalSide` (`busy`), `renderSessTop` (the count and the
re-ranking). Left: `tokensOf` and `allTokens` (the Requests tab counts
every token by design), the hit-rate denominators (already
cache-inclusive), the Overview's chart, tiles and rows (`usageTokens` since
#2378), the sessions tile's median and p90 (`Stats.Overview` ranks in and
out; the tile says "tokens in and out per session"), `Totals.Tokens` in
`internal/usage/usage.go` (CLI/TUI — "Tokens is what went in and out,
excluding cache traffic", its own comment; left for its own issue, as the
thread says).

**When the read fails**: a day's row without cache counts adds 0 to the
buckets (`r.cache_read || 0`), not NaN. The API's rows always carry the
counts (Go marshals the ints), so this is not separately asserted.

**Not verified**: the built desktop app (the browsers are Chromium and
WebKit), zh-TW, ja and de (no new strings; the reused ones have all four).

**AI**: I've read the whole diff and can answer questions on it myself.
