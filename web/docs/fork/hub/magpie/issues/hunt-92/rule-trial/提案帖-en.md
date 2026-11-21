# routing: try a group's rules on a message before saving them

A real case: a user routes with a group, intent rules and a small classifier (Clef on Cloudflare Workers AI, say). The intents are written in English, as the templates suggest: `a hard task: designing, debugging, a change across several files, or planning`. Then they are stuck: their own message — 帮我把这个函数改成并发安全的 ("make this function concurrency-safe") — will the classifier call it hard or easy? The rule doesn't say: its behavior is whatever the small model answers for that message. Today the only way to learn it is to save the draft, run a real agent conversation, and read `classWhy` on the Routing page. Every wording change walks the loop again.

## Proposal

A try box under the rules in the group editor. Paste a message and see, in under a second in the GUI, which intent the classifier picked, which rule matched, and which member goes first — for an unsaved draft.

## Implementation

- One decision function for try and live traffic: the part of `ruleFor` that keeps nothing is split out as `turnDecide`. A live turn calls it and keeps what it decided under `turnRules`, as before; `TryRule` only calls it. No dry-run flag crosses the hot path.
- A try asks the classifier by itself (`directAnswer`): no shared cache read or write, no rest for a classifier that failed, no failure note on the group's card, and no request to any member.
- Three entries: the editor's try box, `POST /api/groups/try`, and `magpie group try <id> <message…>` — the CLI decides beside any running magpie, asking the classifier itself from the same files, for a saved group.
- The answer is the trace's own `RuleHit`, rendered by the Routing page's existing `ruleWhy`/`classWhy`.

## Verified

- 14 cases on real machines, macOS and Windows, all passing. On Windows the GUI's real classifier calls took 548–791 ms and the CLI 0.79–1.08 s (process start included); on macOS the CLI decided in 654 ms. No member model took a request the whole time. A try's classifier call is recorded like any classifier call (`agent: magpie`, `kind: routing`) and shows on the Routing page with the classifier badge.
- Branch [ggbdpq-try-rule](https://github.com/ggbdpq/magpie/tree/ggbdpq-try-rule): `22952132` is the feature, `b96469dc` fixes the single-intent wording. Both commit bodies carry the full record: guard tests shown red when broken and green restored; `go vet` and `go build` on darwin, linux and windows; the GUI in Chromium and WebKit — `routing-rule-try.test.cjs` 16/16, and the 17 group-editor regression files it runs with, 194 tests across both engines.

## Savings (an estimate)

Tuning a group of 2–3 intent rules usually takes 5–20 tries. Each try today is a real agent conversation (about 10k–50k tokens) plus 0.5–2 minutes of hands-on time; a try is about 150 tokens and under a second.

## Boundaries

- Purely additive: remove it and no existing path changes.
- It serves users who write intent rules and iterate on their wording. A group with no deciding rules says so at once and asks the classifier nothing.
- A try is a preview: a conversation's first turn, no reasoning, images or folder, and it knows nothing of affinity or rests.
- One observation: with a single intent in the group, small models occasionally lean toward 1 (one "hey, what's up?" came back as a hard task). A try shows this; it doesn't fix it.

## Open question

On the Routing page, a try's classifier call looks the same as a live one. Whether to tell them apart (a field of its own) is the maintainer's call; the branch doesn't do it.

---

**Attribution**: If these commits are applied, please keep their author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**AI**: written with AI assistance — `Generated-by: GLM-5.3-Flash (ZCode)`.
