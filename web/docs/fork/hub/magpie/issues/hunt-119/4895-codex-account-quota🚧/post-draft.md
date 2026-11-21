This is the "Usage only" model setting doing what it says, not the account routing ignoring B. One change on the codex provider's model picker puts B back in the path.

## What happened, in the code

"Usage only" on a provider's models means *route nothing to it* — no agent or routing group uses its models, and its balance and usage still show (the picker's own description). For the codex provider it also narrows the native model list Codex sees to none (`ServesNone`; internal/provider/codex_models.go, "Usage only narrows the visible native list to none, as it does the general catalog").

A Codex thread on this computer then sends every turn to magpie's `/v1` with a model magpie serves nothing for. That request is answered on Codex's own ChatGPT sign-in: `codexOwnOffMagpie` (internal/gateway/codex_own_v1.go) catches a local Codex request whose model resolves to nothing in magpie and is one of Codex's own models, rewrites it onto the ChatGPT backend's route, and signs it with Codex's own token (`provider.CodexSignInAsKept` — account A's auth.json). The usage row is written with `Provider: "openai"` (internal/gateway/codex_backend.go), which the routing records read as `Codex's own sign-in`. Account B is never considered: it is only first *in magpie's account pool*, and this path doesn't use the pool.

That is also why switching Codex's own sign-in to B earlier "worked": on this path the account that pays is the one Codex itself is signed in to.

## The configuration that does what you want

Keep everything as it is, and change one thing — the codex provider's model setting, from "Usage only" to "Vendor's list" (or "Picked only" if you want to narrow it):

- A stays Codex's own sign-in (the "keep Codex signed in" pick = A), B first in magpie's pool, "Only switch Codex's sign-in" off — that combination is right for it: the pool is what magpie's proxy path uses, and with SwitchOnly off it isn't reduced to rewriting Codex's auth.json.
- With a served model, Codex's turns are proxied through magpie, which picks the account pool's first with room — B — and moves to the next account (A) when B's window runs out (#524, #1432 semantics).

## Your other questions

- **How to confirm B answered**: the routing record for a proxied turn names the account that served it (the account's email in the record's host, `provider.Where`), and the usage CSV attributes the row to B. A row reading `Codex's own sign-in` is, by construction, A.
- **Does an existing session or session affinity affect this?** Session affinity only sticks a turn to an account *inside* magpie's pool; it never sends a request out of the pool onto Codex's own sign-in. Only the model setting (or disabling the provider, a disabled model, a model held to another account by key/account headers) does.
- **v0.1.2693 vs v0.1.2701**: this is configuration semantics, not a version regression — no change in this surface between the two. Still worth re-checking under 2701 with the model setting changed, since a thread keeps the provider it started on (a new thread after the change is the clean test).

Not verified: no ChatGPT Plus accounts here — this is read off the code at today's tip (`c86fa2a34`), where the same pieces are in force; the picker labels are the UI strings your report names (Usage only, Vendor's list, Picked only).

---

**Attribution**: AI-written analysis; please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
