Cross-checked against the current tip (`db7c57670`) — I agree with @MYCF711 that this can be closed. Two independent confirmations on top of your verification:

**1. The display rule is intact at the tip.** `3b5dccd52` (= tag `v0.1.2247`, the fix for this issue) still reads exactly as @yetone announced: `AccountShownOf` is `cmp.Or(AccountLabelOf(id, user), user)` with `AccountLabelOf = cmp.Or(AccountNameOf, PluginUserOf)` — the account goes by the name you gave it, else its plugin's `usage().user` (the in-memory read, else `quotas.json`), else its `accountId`, and it never goes blank (`internal/provider/account_names.go:135-147`). `TestPluginAccountShownByItsUsageUser` passes at the tip.

**2. The edge you couldn't reproduce is exactly as you read it.** In `keepLast` (`internal/provider/quota_last.go:81-83`), any window with `w.matches != nil` returns before the reading is written — the code comment says "a pool that can't be written down isn't kept" — so a plugin whose usage comes back as model pools leaves nothing in `quotas.json`, and after a restart the account shows its id until the first live read. That is deliberate and documented in the fix's commit message ("Not tried: … A plugin whose windows are all model pools isn't kept in quotas.json, so after a restart it shows its id until its first read.") — a known limitation, not a regression.

Nothing left open on the magpie side from here.

**Attribution**: AI-written; I've verified the claims above against `db7c57670` and run `TestPluginAccountShownByItsUsageUser` on it.
