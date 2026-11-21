Re-verified at current main (`eb1b83000`) — the two commits rebased with zero drift (range-diff identical).

| Element | Evidence at `eb1b83000` |
| --- | --- |
| Rebase | `hunt-20261112-t1-5273` = `eb1b83000` + the two commits, range-diff identical |
| git am | the series replays on a clean `upstream/main` to a byte-identical tree |
| Tests | the browser regression `models-select-none-filter.test.cjs`: 20/20 pass on this machine (Chromium/WebKit, Playwright); `TestCoreScriptBudget`: ok; `internal/gui` full run: two reds — `TestProxyCheckSaysAProxyPassedBy` (documented standing red) and `TestSessionReadsRoutes` (full-run interaction), both failing the same on the base commit without this series (base full run re-run: identical reds, both pass alone); `GOOS` linux/darwin/windows `nogui` builds ok |
| Ablation | the `app.js`/`i18n.js` changes reverted to the base with the browser test kept: it fails (0/20); the budget constant reverted: `TestCoreScriptBudget` fails (`1269157 bytes … over their budget of 1268961`) — both restored, green |
| Siblings | `internal/gui` assets untouched by upstream since the patch post; the Select-none filter's siblings (`Select all`'s picker path) stand as scanned |
| Real path | the 20/20 browser run on this machine is the real-path reproduction (real pages, both engines) |

Branch with the commit: [hunt-20261112-t1-5273](https://github.com/ggbdpq/magpie/tree/hunt-20261112-t1-5273) (head `08d58f1d8627078`). Series SHA-256 first 16: `2d0a4ab769331a29` (0001 Select none), `d4c2864b1b05b1a4` (0002 budget).

Attribution: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
