Fixed on `main` by `41b5c0f19` (first in v0.1.2479) — suggestion 1 is what landed.

`NextLogin` used to sign Claude Code back in to the first account as soon as that was under 90% again, under every routing — switch-only included, exactly the timeline above. That commit adds `returnsToFirst` (internal/provider/codex_switch.go): where the sign-in alone spends the accounts — Claude Code always, Codex under switch-only — the sign-in now stays on the account it moved to until that one is spent or fails too, and the return record it still writes is honored only under those two. Going back stays where the user said the first comes first: routing In order, or KeepLogin.

So with switch-only on and neither of those, your 05:41 and 17:23 switches no longer happen: B is used until it is spent, and A is only signed in to once B is out — one switch per 5-hour window instead of two, and the prompt caches of running sessions survive the other account's reset. `TestSignInStaysOnTheAccountMovedTo` (new in that commit) pins it: claude, claude switch-only and codex switch-only stay; claude In order goes back.

On the other two suggestions: with no return under switch-only, an idle check (2) has nothing left to gate, and a `noReturn` toggle (3) would only matter under In order or KeepLogin — where going back is the setting's own meaning ("No user setting is overridden: In order and KeepLogin keep their meaning", from the commit). Overriding those would be a new feature rather than a fix; if you were on In order and want no return even there, say so and it can be judged on its own.

v0.1.2229 predates the fix; v0.1.2479 or later has it.

written with GLM-5.3-Flash (ZCode).
