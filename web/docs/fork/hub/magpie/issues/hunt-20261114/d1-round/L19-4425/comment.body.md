I took this earlier and had to let it go; closing out my read of it here so the mechanics are on the record.

Everything you observed traces to two declared designs working together, not to a defect I can patch:

1. **The "in magpie already … left as it is" no-op.** `importLogins` dedups on refresh tokens magpie already holds, "the agent's own included" (`internal/provider/login_import.go`, the `have` map), and never refreshes one it holds. That has been file import's founding behavior (3ba6ff7d2: "A refresh token magpie holds already (saved or the agent's own) is 'Already in magpie' and never refreshed"), it is asserted by `TestImportCodexLogins` ("the live account is left as it was"), and the confirmation box says it before you agree: "An account magpie holds already is left as it is." So while discovery serves the account straight from `~/.codex/auth.json`, an explicit import of the same file has nothing new to take — ownership is never moved, and `codex logout` (which per your experiment revokes the refresh token magpie shares with Codex) lapses magpie's account with it. The "sign-in has expired — add the account again" you saw then is the revoked-sign-in detection from the #4308 fix working as intended.

2. **The reappearing `~/.codex/auth.json` in your second experiment.** After an import rotates the token, `addLogin` signs the local agent in to the account it adds when the agent has no account yet — `using = !signedIn || sameLogin(live, l)` (`internal/provider/signin.go`) — writing the new tokens where Codex keeps its sign-in: "The agent is signed in to it too when it has no account yet … so one refresh token stays in one place" (design since #15). Magpie and this machine's Codex CLI share one refresh token on purpose, so `codex logout` revoking it takes magpie's copy down with it. (This is read from the code, not reproduced at runtime.)

3. **What a decouple would mean** — both halves are design calls rather than something I can patch: (a) import stops re-signing the local Codex in, leaving it holding a spent token; or (b) an explicit take-over mode that rotates an already-held token and leaves `auth.json` alone, signing the local Codex out from then on. Both contradict the declarations above. Your third suggestion — documenting that a ChatGPT subscription account can't be severed from the local Codex sign-in — is the one that changes no behavior, and I'd second it.

Until there is a decision on this, the account stays safe as long as `codex logout` isn't run on it: discovery keeps serving it from `auth.json`, and renewal happens in place.

---
Attribution: analysis written with GLM-5.3-Flash (ZCode); I've read the code paths cited above.
