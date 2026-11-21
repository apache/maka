Thanks for the report and the screenshot. I read the code paths behind those three rows (Settings → Codex thread titles / thread descriptions / composer predictions) on current `main`, and I could not find a path where "Codex's own (ChatGPT)" sends them somewhere the conversation itself does not go — so before anything can be fixed, I need a few facts about your setup that the screenshot alone can't tell me.

**What "Codex's own (ChatGPT)" actually means in magpie**

The setting saved is an empty value, and its meaning is "as Codex sends them" — it does not override the model, whatever model Codex itself put in the request (`codexTitlesTo`/`codexDescriptionsTo`/`codexPredictionsTo` in `internal/gateway/codex_titles.go`; the routing doc says the same: "an empty setting preserves the requested model").

Which model Codex itself puts in depends on how it reaches magpie:

- **Codex with magpie as its model provider** (its `model_provider` points at magpie's `/v1` with a gateway key): Codex sends these hidden turns (thread_title, thread_description, composer_predictions) **on the conversation's own model** — that is what Codex does with any third-party provider (pinned by `TestCodexTitleOnMagpieProvider`). If your conversation runs on a model that belongs to a routing group — e.g. your "fable" group — then "Codex's own" keeps those calls on that same model, and the Routing and Usage views record them under that group. From the outside this looks like "the titles got routed to the fable group", but it is Codex itself asking for them on the conversation's model; magpie did not move them anywhere. In this topology there is no ChatGPT involved for these calls at all — Codex never asks ChatGPT, because it is asking the conversation's model.
- **Codex signed in to ChatGPT, relayed by magpie** (through `/backend-api/codex`): a title/description/prediction on one of Codex's own models (gpt-5.6-luna and friends, no `/` in the id) is **not intercepted at all** with the empty setting — it is relayed as it came to Codex's own ChatGPT sign-in, and the Routing view shows it as "Codex's own sign-in" (OpenAI), never as a routing group. Only a magpie model (a `provider/model` id) is answered by magpie, on that same model.

So the behavior you describe is exactly what "Codex's own" does when the conversation's model lives in a group. The ChatGPT promise in the label holds only for the second topology.

**What you can do right now**

- If you want these calls to stop going to the fable group, pick an explicit model for each of the three rows (any model of magpie's, e.g. one on a ChatGPT account), or "off" for titles and predictions (an "off" exists only for those two; a description must be written by some model). An explicitly picked model is used as-is and is exempt from the calling key's model restrictions.
- If you want ChatGPT to write titles, Codex needs to be signed in to ChatGPT and the thread on one of Codex's own models, relayed via magpie's Codex backend path — then the empty setting leaves them on the sign-in.

**What would settle it, if you believe it is still wrong**

Please send:

1. Your magpie version.
2. How Codex reaches magpie: `model_provider` pointing at magpie's `/v1` with a gateway key, or ChatGPT sign-in relayed via `/backend-api/codex`?
3. Which model the conversation's own turns are on (the Routing view rows for the chat itself, same session), and whether that model is a member of the fable group.
4. For **one** title/description/prediction row that went to the fable group: the requested model, its Kind, the provider/group that answered, and whether the row carries any error or handed-on note (the codex-subscription fallbacks can also land calls on other models, but only after a failure, and the row says so).
5. After restarting magpie, do the three pickers still show "Codex's own (ChatGPT)"? (This rules out an older saved value.)

If your conversation runs on one of Codex's own ChatGPT models and title rows still show the fable group with no failure or hand-on noted, that would be new information — please send that routing record and I will dig again.

**AI**: this diagnosis was written with GLM-5.3-Flash (ZCode); the code reading behind it is in the worktree and I can answer questions on it.
