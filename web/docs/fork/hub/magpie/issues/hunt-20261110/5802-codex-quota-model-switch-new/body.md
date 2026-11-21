Triage notes on this one — what the report shows, and what magpie does on current main (`b27b66046`), because I could not reproduce a magpie-side cause:

**What the screenshot shows.** The banner ("Codex 和工作使用额度已用完 … 20:02 重置", with 重置使用量 / 升级) is Codex Desktop's own rate-limit UI, and the "hi" typed next to it is not sent — there is no request of that turn in the report, and none is expected: after the backend answers `usage_limit_reached` (plan, reset time, the `x-codex-*` windows), Codex locks prompt submission until the reset, app-wide, whatever model the picker shows. The lock is client state; magpie is not asked.

**What magpie does, and why.** When every ChatGPT account a Codex turn could go on is used up, magpie tells Codex the 429 as the backend gave it — `usage_limit_reached` with plan and reset — rather than re-typing it as a retryable error (`559bf71e9`, `TestCodexEveryAccountOutToldAsTheBackend`): re-typed, Codex retried until it stopped on "exceeded retry limit" (bitssly on X), which was worse. That translation is what arms the client-side lock, deliberately. On the other side, a turn for a model of another provider is routed on that provider's own candidates: rests are kept per key or account (`provider@user` / `provider#key`, rest_store), and a ChatGPT account resting can hold nothing of DeepSeek's. magpie's Codex backend shim serves `GET /models` and nothing else — there is no usage poll of it that could carry the lock over.

So what you hit is Codex Desktop holding the whole app to the ChatGPT plan's reset, including on models that would never touch that plan. magpie cannot lift it from its side — the turn never arrives.

**What would decide it.** A row on magpie's Requests page for one attempted DeepSeek turn. The report has none, which matches the client-gated reading; if one does appear on your side, post it and I will re-examine.

**Meanwhile.** 重置使用量 (one of Codex's own rate-limit reset chances), waiting out the reset, or running the external model from a client that does not share the ChatGPT sign-in until then. The standing want — magpie taking the conversation over automatically the moment the subscription is out — is tracked in #3603; this report is good evidence for it.

(your magpie is 0.1.3378; current is 0.1.3467 — nothing in between changes this picture, but upgrading is worth it all the same)

Generated-by: GLM-5.3-Flash (ZCode)
