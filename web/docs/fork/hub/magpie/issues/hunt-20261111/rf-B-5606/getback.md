Status check on current `main` (`10c331531`) — the branch stands: @v5tech's read holds on today's tip too.

- Cherry-picked `f712c83e1` onto `10c331531` with zero conflicts: [`hunt-20261111-rf-5606`](https://github.com/ggbdpq/magpie/tree/hunt-20261111-rf-5606) (head `11a377ce0f5f2279`), two files, the `app.js` face 9 lines. Patch (git am): SHA-256 first 16 `a13444b0d536070c`.
- The names-masking judgment upstream touched since `803d7747e`: none — `git log -S "NOT_ACCOUNTS" -S "accountNames"` over `f712c83e1^..upstream/main` answers empty; `app.js` moved around it (2685 lines elsewhere), not in it.
- The engine leg is @v5tech's now: `account-mask-namesake.test.cjs` 4/4 on Chromium+WebKit × en/zh, red before, green after, red again on ablation — the leg this branch could not run itself (no engine here), recorded above. `node --check` passes on the test file.
- Behavior unchanged from the original description: a name that is both an account's and a provider's hides as the account's; `NOT_ACCOUNTS` brands stay put; card labels keep their element exemptions. Known trade-off as stated: a provider row named like its account hides its `.name` too.

Thanks @v5tech for the platform leg and the trade-off wording — nothing to redesign; the merge call is yetone's.

**Attribution**: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

