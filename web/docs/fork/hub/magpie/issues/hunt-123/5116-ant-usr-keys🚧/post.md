I took this and went through every place magpie looks at an `sk-ant-` prefix, at current main (`c360d9d30`). The misroute you observed — Claude Code identity headers on a Console key, billed on the wrong channel — is real and worth pinning, but the mechanism you infer isn't in magpie's code, so the deciding data is how the key was added. Credit @atlaswang89-cyber for the report — the channel observation is what makes this worth chasing.

**What the code actually does with prefixes**

- `claude_setup_token.go` (`checkClaudeSetupToken`): a paste into the **setup-token** flow refuses an `sk-ant-api` key outright ("this is an Anthropic API key, not a setup-token") and refuses anything not `sk-ant-oat`. An `sk-ant-usr-` key is refused here, not classified.
- `gateway/claude_signin.go`: a client's `Authorization: Bearer sk-ant-oat…` is recognized as Claude Code's own OAuth and never passed on — a check on *incoming* client headers, not on stored keys.
- There is no `_is_oauth_token`-shaped classifier in magpie: no code path reads a stored key's prefix and defaults "not `sk-ant-api` → OAuth". That function name smells like another tool's (cc-switch-style managers have one) — which is exactly why the add-path matters.

**Where the misroute can actually come from**

Claude Code identity headers go on only when the credential is in the **subscription-login** bucket (a sign-in or an accepted OAuth token in logins.json), never for an API-key provider's key (those go out as `x-api-key`). So the key reached that bucket through whatever flow added it — and the flows differ: the sign-in import, a setup-token paste (which would have refused it), or a manual add. Each points at a different fix, and one of them may simply be a missing refusal like the setup-token one.

**The two artifacts that decide it**

1. **How the key was added** — which screen/flow (Claude sign-in, setup-token paste, provider editor's key field, an import from another tool). If it was an import, name the tool and its export shape.
2. **One failed request's record** (Usage → Requests, the try's detail): it shows which account/credential magpie selected and the headers class it sent — that names the bucket the key landed in, and with it the seam to fix.

If the answer is "a flow accepted it into the login bucket without checking", the fix is your positive-match proposal applied at that flow's door (`sk-ant-oat` → login, `sk-ant-api*` including the new `sk-ant-usr-` → key, anything else → refused with the two named) — a small patch I'll send once the door is named.

**Not verified:** no `sk-ant-usr-` Console account here, and the add flow wasn't reproduced — the prefix enumeration above is the whole of magpie's handling, read at `c360d9d30`; your `_is_oauth_token` inference is treated as a hypothesis, not a fact about this codebase.

AI use: analysis written with GLM-5.3-Flash (ZCode) from a code read of the repo; no requests were sent to any upstream.
