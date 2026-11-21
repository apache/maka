Triage notes, from the two log screenshots — several things are visible in them, and they tell a more specific story than "switching doesn't work":

**Reading the rows.**

- `17:51:49 group/limit-quota ✗ 200·失败` — the turn asked of the group went to its StepFun member (step-5-preview), ran 94s, and failed mid-reply with the whole prompt cached (416.8k token, 缓存 100%). A 200·失败 is a reply that said an error part-way through, so the turn died after the vendor had read (and cached) the whole prompt.
- `17:54:0x workbuddy/hy3 … 5.8s / 8.1s, ~1k token, $0.000` with the 图片描述 tag — those are magpie's image-description side calls, which pick their own model; they are not your conversation's turns.
- the `499·已取消` rows at 17:54, on both `workbuddy/hy3` and `group/limit-quota` — 499 is how magpie records "the agent gave up before anything was sent": the request arrived, routing had nothing ready to hand it to (or was still waiting on a slot), and the client's patience ran out at 3–7s. So requests for both models were reaching magpie and being cancelled, back and forth — that is the "无法切回" as the log sees it.

**What magpie does with a switched model.** A conversation's stick is kept per model or group: the key it is kept under is `<provider>/<model>` (or `group/<id>`) + the conversation id (affinity.go, stickKey). Switching to a different model therefore starts fresh — routing weighs whoever is ready, no stick carries over, which is deliberate: "a conversation's affinity is to one model: another's cache is its own". What does carry, within one group: after a member fails, the turn goes to another member (that is what a group is for — which member is "random" to you is the routing mode's pick among the ready ones), and the conversation then stays with that member while what the vendor cached of it is worth keeping — and 416k tokens cached is worth keeping by the setting's own threshold (cacheWorth 1024). It gives the conversation back when the failed member is ready again if the group is In order ("order"), or per a provider's fallback ("main"); Smart keeps it by the cache until it goes cold.

So: "出错后落到 hy3 并留在那里" is the group doing its job plus the cache rule; "切了模型还路由旧模型" would need the switch to have reached magpie as a different model and been ignored — nothing in the code does that, and the screenshots show both labels being asked, so the switch did reach magpie; what bit is that everything got cancelled as 499 before anything could serve.

**What would pin it down.** The Requests page's route detail has an Affinity line with a why label (`strict` / `order` / `main` / `busy` / `resting` / `first` / `gone`) for the turns after 17:51 — that one word says which rule held the conversation, and turns this from a reading of the rows into a verdict. Also useful: the group's routing mode (In order / Smart) and its Affinity setting, and whether hy3 is a member of limit-quota or a separate group you switched to. If the why says something you didn't ask for on a turn whose model genuinely changed, that is a bug and I will take it as one.

Same-shape report, for the record: #5295.

Generated-by: GLM-5.3-Flash (ZCode)
