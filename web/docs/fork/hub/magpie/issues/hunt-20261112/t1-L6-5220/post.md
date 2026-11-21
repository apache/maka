This is the documented exception firing, not the 30-minute lead running early — and your own records pin it.

**What spent the card** (`internal/provider/codex_expiring.go` at main): `expiringResetSpent` spends a reset `resetLead` before it runs out (your "use before expiry", the default half hour) — **or at once, when the account is held up now and won't be free again before that moment**: `stopped && (back.IsZero() || !back.Before(at))`. The reasoning is in the file: what the windows have left can't be used before the reset would be spent anyway, and spending it frees the account. Your week sat at 0% with recovery on Nov 7 14:34 while the card ran out "约 3 天" after Nov 4 18:07 — i.e. within the exception's window (the exception fires whenever the account is still held up at expiry − 30 min; your recorded `why: "expiring"` spend at 18:07:32, 25 minutes after the 0% reading, is that path, not the lead).

This behaviour is declared at three layers, so I'm not patching it:

- The commit that introduced the exception spells it out (`da46cd21f`, #718: "It is spent at once when the account is held up now (usedUp…) and won't be free again (BackAt; not known counts as not) before the reset would be spent: waiting can use nothing more, and spending it frees the account").
- A test guards it: `TestResetSpentAsLateAsSafe` walks the reported afternoon and has "five hours free after it runs out → spent 15:20" as a green case (`codex_expiring_test.go`).
- The tooltip says so, on the expiring switch itself: "已开启：最早到期的重置卡在到期前{lead}自动使用（需账号已用过额度；**若限流到那之后才解除，则立即使用**）" (en: "…or at once when the account is held up until after then").

**Your asks are still fair product feedback**, and I'd weigh them as such rather than as a bug: (1) an expiring mode that strictly waits for the lead, leaving the held-up exception to a separate, explicit switch — note the exception predates the two-switch split (#2078), which kept it on both switches' help text; (2) a used-record that says which condition hit and how far from expiry the card was — `codex-resets-used.json` shows only `why: "expiring"` today, and with the condition recorded your diagnosis would have been a one-look instead of an inference. Both are the maintainer's call. (The "use when the week is used up" switch you turned off is a different path — `AutoUseCodexReset`, the week's one card; it played no part here.)

Not verified: your real account — all of the above is your records plus the code at `f6c882ad7`.
