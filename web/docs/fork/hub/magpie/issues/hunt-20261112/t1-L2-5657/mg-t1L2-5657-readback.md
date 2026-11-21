One premise in this report doesn't match what magpie does, and it changes where the fix would live — so let me lay out the actual surfaces, then what would pin the face you are seeing.

**magpie does not store your prompt "rounds" for later injection.** The 轮 (turns) magpie shows on its pages are a measurement of what the client sent per request — how many user turns a conversation carried and what tokens each part took (internal/gateway/prompt.go) — not a store magpie keeps and re-sends. Nothing in magpie re-injects earlier user prompts into a conversation; after a compaction, the context your session continues with is assembled by Codex itself, from the summary its compaction produced and what it decides to restore.

**Where magpie does sit in that flow** — the two places it touches a compaction at all:

1. A provider rule's compaction condition can send the summarization request to a different model than the session's own. If the conversation's summary came from a weaker model, the summary it wrote can absolutely drop things — a `/goal` you set mid-session included. Which model summarized is not a guess: compaction calls are recorded on the usage page with their purpose (Compaction) and their model.
2. With Codex's background compaction (async_compaction), magpie answers the compaction trigger the same way — its own compaction prompt, or the provider's native one — and that answer is the summary Codex takes in at the next step. Again: magpie summarizes what the client sent; it never drops a turn on its own.

So "the injected prompt only has round 1's content" is the restored context your client built from whatever summary was made — if the goal text made it into the requests magpie saw but not into the summary, the loss happened in the summarization step, and the recorded compaction call on the usage page shows who did it and what it was asked.

**What would pin this down**, since the report has no version or logs yet:

- the magpie version, and the client (Codex CLI or the app, its version);
- whether a provider rule with a compaction condition is set, and to which model;
- the usage page's Compaction records around the moment of the compaction in your example;
- where you read the "注入的提示词" from — the trace/context view, or the session's behavior after compaction.

With those, if the summary is dropping content the compaction request carried, that is a real face worth its own report with the evidence attached; without them, there is no magpie-side failure to reproduce — nothing in the flow described touches magpie's code in a way a patch could change.

Not verified: everything above is read off the current code (`f6c882ad7`); no runtime repro attempted, as the report names no versions and no logs.

Attribution: AI-written; I've read every line cited. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)

