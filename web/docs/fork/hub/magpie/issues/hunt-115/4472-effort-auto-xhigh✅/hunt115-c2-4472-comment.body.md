I took this one (the `take` above) and went through the decide path in the gateway. I have no TypeSafe account, so this is from the code at main (`bd5152ce3`) plus real decision answers recorded in magpie's own tests — and no patch: which request shape jev-latest actually needs is exactly what one replay at TypeSafe decides (bodies below), and I'd rather not re-shape a question every decision provider shares on a guess.

**The two configs send the same request except for one question.** Building both bodies (`jevBody`): with `effort` unset the questions are `intent` and `level`; with `effort=auto` exactly one question is added —

```json
"effort": {
  "type": "score",
  "instructions": "How much reasoning does a coding assistant need to handle the `message` well?",
  "criteria": [
    "Little to think about: a greeting, a question answered from what is already known, a mechanical or one-line change, running a command",
    "Some thought: an ordinary bug fix or a small feature in code already understood",
    "Careful thought: a change across several files, a bug whose cause is not known yet, a design choice with trade-offs",
    "Deep thought: a subtle bug (concurrency, performance, security), an architecture or algorithm to design, a long multi-step plan"
  ]
}
```

— with `state`, `intent` and `level` byte-for-byte identical. Nothing in the decide request varies with the client's effort either: for the first turn of a fresh session the body is the same whether Claude Code asked medium or high. So your medium run (2.92–2.98) and your high run (2.31–2.71) sent the same bodies per prompt, and the spread between the runs is the classifier's sampling, not a second shape.

One of your "Not checked" items I can answer from the code: `jevState` sent the prompt itself as `message` — masking records a `decide` line only when it swapped something (`noteMasked` writes no record when nothing matched), and none of your prompts had anything to mask, so redaction changed nothing in what Jev read.

**What magpie does with the score is not the misread.** A System One `score` answer carries probabilities keyed by criteria index, and `score` is the weighted index. Two real answers recorded in this repo confirm the convention:

- clef-flash (`internal/gateway/decide_sure_test.go`): probabilities {0: 0.75, 1: 0.2, 2: 0.05, 3: 0} → 0×0.75 + 1×0.2 + 2×0.05 + 3×0 = 0.3, the `score` field as sent.
- Volcengine Ark (`internal/gateway/decide_ark_test.go`, recorded 2026-11-01): `score` 2.0494 = 0.0932 + 1.4657 + 0.4906 over {0: 0.0105, 1: 0.0932, 2: 0.7329, 3: 0.1635}, with `"legend":{"0":"none","1":"low","2":"medium","3":"high"}` — the legend matching the criteria order.

`readJev` rounds that index over the four levels (low, medium, high, xhigh): Ark's 2.049 comes out `high`, and a 2.98 — your table's numbers — means the classifier itself put ~99% of its likelihood on index 3, "Deep thought", for `ok`. The all-xhigh is Jev's answer to the score question, not a rounding or mapping slip in the gateway.

**Why the intents drift too.** With more than one intent rule, magpie makes one extra call before the turn (once per model + intents, cached for the life of the process): are these kinds one scale, and how much work each is. When that call says "one scale" (noul ≥ 0.5), routing counts the **level** answer, not the intent one — and the level question's criteria carry per-rule work texts assigned from the work scores. If those work scores are pinned high like your effort scores, nearly all four work descriptions land on one rule. I ran magpie's own assignment (`levelsOf`) on your three intents with pinned scores [2.98, 2.92, 2.97]; "Changing code, fixing a bug, debugging…" comes out described as:

> The lowest level: little work: a question, an explanation, a one-line or mechanical change, a command to run; some work: …; much work: …

— so a question or a greeting matches that rule on every message. That is your second intent, the question and `/triage` included. Whether the level answer counts is decided by the one-scale call, drawn once and cached: two runs in different processes can draw differently, so the 8-of-8-unset vs all-drift contrast doesn't need the effort setting as the cause — one disease (score answers pinned near the top) explains both symptoms.

**What would pin it down** — two calls replayed straight at TypeSafe, not through magpie, and the answers pasted here:

Call 1, the effort question alone:

```json
{"model":"jev-latest","state":{"message":"ok"},"questions":{"effort":{"type":"score","instructions":"How much reasoning does a coding assistant need to handle the `message` well?","criteria":["Little to think about: a greeting, a question answered from what is already known, a mechanical or one-line change, running a command","Some thought: an ordinary bug fix or a small feature in code already understood","Careful thought: a change across several files, a bug whose cause is not known yet, a design choice with trade-offs","Deep thought: a subtle bug (concurrency, performance, security), an architecture or algorithm to design, a long multi-step plan"]}}}
```

Call 2, the one-scale call magpie makes once for your three kinds:

```json
{"model":"jev-latest","state":{"kinds":["A standalone question, explanation or status lookup, or drafting a short Slack or client message.","Changing code, fixing a bug, debugging, planning, reviewing, designing, or running git or release steps.","The message runs the /triage or /prototype command."]},"questions":{"levels":{"type":"noul","instructions":"Are these `kinds` levels of one scale that every request to a coding assistant is at, such as how hard, how big or how urgent it is — rather than topics or tasks that a request may be none of?"},"work0":{"type":"score","instructions":"Taking `kinds` as levels of one scale for requests to a coding assistant, how much work is a request at the level `kinds[0]`?","criteria":["little work: a question, an explanation, a one-line or mechanical change, a command to run","some work: an ordinary bug fix or a small feature in code already understood","much work: a change across several files, a bug whose cause is not known yet, a design choice","the most work: a new program, app or game, an architecture, a long multi-step plan"]},"work1":{"type":"score","instructions":"Taking `kinds` as levels of one scale for requests to a coding assistant, how much work is a request at the level `kinds[1]`?","criteria":["little work: a question, an explanation, a one-line or mechanical change, a command to run","some work: an ordinary bug fix or a small feature in code already understood","much work: a change across several files, a bug whose cause is not known yet, a design choice","the most work: a new program, app or game, an architecture, a long multi-step plan"]},"work2":{"type":"score","instructions":"Taking `kinds` as levels of one scale for requests to a coding assistant, how much work is a request at the level `kinds[2]`?","criteria":["little work: a question, an explanation, a one-line or mechanical change, a command to run","some work: an ordinary bug fix or a small feature in code already understood","much work: a change across several files, a bug whose cause is not known yet, a design choice","the most work: a new program, app or game, an architecture, a long multi-step plan"]}}}
```

Back from call 1: `answers.effort` — `score`, `probabilities`, `confidence` and `legend`. Back from call 2: `answers.levels.noul` and each `answers.workN` — `score`, `probabilities`, `confidence`.

Two outcomes, either decisive:

- probabilities ~all on "3" with a sane legend (0 = the low criterion … 3 = Deep thought): jev-latest's score answering is the weak point, and the fix is to ask it in the form it answers well — its choice answers were 8 of 8 for you, so effort as a choice over the same four levels is the candidate; that changes every decision provider's path, so it wants a real answer in hand first.
- a legend in another order (say 0 = Deep thought): jev-latest reads the criteria array in another order, and the gateway should read the legend and align — a small, safe fix.

---
**Source**: reported in #4472; from the code at main (`bd5152ce3`) and real decision answers recorded in magpie's own tests. Not verified against typesafe/jev-latest — no TypeSafe account here; the two calls above are what would settle it.

**AI**: written with GLM-5.3-Flash (ZCode).
