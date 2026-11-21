**Verdict: an API-organization credits grant and the ChatGPT API (Sign in with ChatGPT) provider are two separate paths by OpenAI's own design — a signed-in token has no documented way to address an organization, and the supported route to those credits is the plain API-key provider, which magpie already has (`magpie provider add openai …`, org selectable via `header.OpenAI-Organization`).** Nothing patched in this comment; the reasoning and evidence below.

**Re-checked at current `main` (`c32b820a9`, fresh from `upstream/main` today).** All three source observations in the report hold, with line numbers drifted slightly (the report cites an older revision):

| Observation in the report | At tip |
|---|---|
| `siwcAPI` fixed to `https://api.openai.com/v1` | `internal/provider/chatgpt_api.go:51` |
| `siwcCreds` keeps client/host/subject/tokens, no organization or project field | `internal/provider/chatgpt_api.go:86-96` |
| `siwcProvider` signs with `Authorization: Bearer <token>` + session headers only | `internal/provider/chatgpt_api.go:736-749` |

**Why no header can reach these requests today.** Provider-level `Headers` ride on plain key+URL providers only — the field's own contract says "Signed-in agent accounts ignore them: their auth is the agent's own" (`internal/provider/provider.go:265-272`), and `Provider.Sign` returns right after an account's signing for exactly that reason (`internal/provider/account.go:222-227`). The ChatGPT API provider is a built-in signed-in account, so there is no settings surface to attach headers to it either. So this is not an oversight a one-line pass-through could lift; it is the documented boundary between key providers and signed-in accounts.

**What OpenAI's own docs and reference client say.** Two findings, both from OpenAI's side:

- The credits-benefit docs put spending on a separate, key-shaped path: "Grants apply only to the linked API organization. Select that organization and use one of its project API keys when making requests" ([API credits for ChatGPT subscribers](https://developers.openai.com/api/docs/guides/chatgpt-api-credits)), and keep the pools apart: "These API credits also don't increase your ChatGPT or signed-in Codex usage limits." Moving the grant to another organization is a support contact, not a per-request choice.
- Codex CLI defines `openai-organization` as a platform-API-key-only resource selector and its runtime validation requires the header to be *absent* for a ChatGPT-signed-in actor (present and matching only for a platform actor) — `validate_runtime_selectors` in [codex-rs/model-provider/src/runtime_auth.rs](https://github.com/openai/codex/blob/main/codex-rs/model-provider/src/runtime_auth.rs).

Together: no documented semantics for organization selection on a subscription-sharing token, and the reference client actively rejects that combination. A patch sending `OpenAI-Organization` on SIWC requests would be a guess at undocumented behavior — it could route nothing or get requests refused — and it cannot be verified without an account holding an eligible credits grant. That is why this comment ships no code.

**What works today (the report's option 2 already exists).** The built-in `openai` preset is a plain key provider at `https://api.openai.com/v1`, and its requests apply user headers after auth (`internal/provider/account.go:245-263`):

```
magpie provider add openai sk-proj-…    # a project API key of the org the credits are linked to
magpie provider add openai sk-… header.OpenAI-Organization=org-…   # a key that needs the org named
```

Per OpenAI's docs the linked organization's project API key is the documented way to spend the grant; the `header.*` form (`internal/cli/providers_cli.go:1278-1293`) is there for keys that need the organization named explicitly.

**What a change could look like.** Option 3 of the report — stating clearly in the UI/docs that this provider runs on ChatGPT plan usage rather than API-organization credits — matches what the code already assumes (`siwcNoUsage`, `internal/provider/chatgpt_api.go:78`) and is a reasonable product note; that's the maintainer's call, happy to pick it up if wanted. Option 1 (an organization/project field on the SIWC provider) becomes implementable only if OpenAI documents organization selection for sign-in tokens; if that ever happens, this issue is the right place to revisit.

Thanks @zemul for the carefully sourced report — the #3721 cross-reference helped put the quota semantics in context too.

AI use: analysis written with GLM-5.3-Flash (ZCode); every code read above was run locally at `c32b820a9` and both doc quotes were taken from the linked OpenAI pages.
