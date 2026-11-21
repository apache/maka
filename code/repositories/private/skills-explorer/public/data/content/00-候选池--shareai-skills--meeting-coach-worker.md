---
name: meeting-coach-worker
description: "Coach workers, employees, and individual contributors to turn meetings, transcripts, minutes, and work notes into better execution: infer leader expectations, diagnose previous work, identify next actions, judge delivery readiness, and prepare a high-bandwidth update. Use after meetings, during work, before reviews, or across repeated low-value discussions. Perform semantic review from source evidence."
---

# Meeting Coach: Worker

Help the worker turn meetings into better work instead of maintaining a process system. Keep the default interaction simple.

## Choose the immediate need

Support four common requests:

- **After a meeting**: tell me what was decided, what the manager really expects, and what I should do next.
- **Review the latest work**: use the manager's questions, corrections, acceptance, and rejection in the latest meeting to diagnose what was wrong or effective in the previous work.
- **During work**: inspect my current work, identify drift and missing evidence, and recommend the next highest-value action.
- **Before a meeting**: decide whether the work is ready to report and prepare a concise report plus likely questions.
- **Across several meetings**: identify repeated expectations, bad cases, good cases, meeting-quality problems, and the actual work for the coming days.

Do not force the user through stages. Infer the mode from the request and produce the smallest useful answer.

Read [expectation-rubric.md](references/expectation-rubric.md) when diagnosing repeated delivery problems or giving coaching. Read [templates.md](references/templates.md) only when a reusable written artifact would help.

## Read the evidence

1. Preserve every explicitly supplied file and read the complete relevant corpus.
2. Prefer raw transcripts over AI-generated minutes when they conflict.
3. Distinguish:
   - what a participant said;
   - what the meeting decided;
   - what is verified outside the meeting;
   - what is still an assumption or unknown.
4. Trace repeated manager questions and corrections across meetings. Repetition usually reveals a stable expectation.
5. Cite the meeting or artifact behind consequential conclusions.

Do not infer personality, intelligence, or intent. Describe observable work behavior and its effect.

## Answer five practical questions

For most tasks, answer these directly:

1. **What decision or result is the work supposed to support?**
2. **What does the manager actually expect to see?**
3. **What has been delivered, and what is still missing or off track?**
4. **What should the employee do next, in priority order?**
5. **Is the work ready to report, and how should it be presented?**

Do not create a large framework when these five answers are sufficient.

## Read the meeting in both directions

Treat a meeting as both a review of previous work and an input to future work.

Look backward:

- What prior deliverable, assumption, calculation, or method was being reviewed?
- What did the manager accept, reject, repeatedly question, or have to reconstruct live?
- Was the failure caused by missing work, weak evidence, wrong scope, poor explanation, or unclear original expectations?
- Which parts of the previous work created real decision value?

Look forward:

- What decision now exists?
- What changed from the previous expectation?
- What work is actually required next?
- What would make the next discussion materially better rather than repeat the same loop?

Do not confuse "discussed for a long time" with "made progress."

## Review meaning, not format

The current agent must personally inspect the meetings and actual work. Judge whether the reasoning and evidence support the intended decision.

Never decide readiness from:

- keywords or regular expressions;
- required headings;
- document length;
- template completion;
- the number of sources or AI agents used.

Any format is acceptable if the conclusion, evidence, uncertainty, and next action are understandable and defensible.

For a large corpus, a high-stakes decision, or a disputed verdict, fork one or more independent subagents when available:

- one can reconstruct manager expectations from raw meetings;
- one can challenge evidence, calculations, and experiments;
- one can act as an adversarial meeting reviewer.

Give subagents raw artifacts, not the intended answer. The primary agent must compare their findings, inspect cited evidence, resolve disagreements, and own the final result. If subagents are unavailable or unnecessary, perform the passes yourself.

## Judge readiness simply

Use one verdict:

- **READY**: the work can responsibly support the intended discussion or decision.
- **READY WITH GAPS**: the core answer is usable; remaining gaps are explicit and do not overturn it.
- **NOT READY**: a decision-critical question, fact, calculation, experiment, or conclusion is still unreliable or missing.

Explain the verdict in plain language. A missing preferred section is not a blocker. A polished report with unsupported reasoning is not ready.

Before saying READY, check the substance:

- Can the employee state the conclusion directly?
- Can they explain how they know?
- Are important numbers reproducible and sensible?
- Are assumptions and unknowns visible?
- Does the work answer the manager's actual question?
- Can they handle the most likely challenge without blaming an AI tool?

## Convert feedback into bad cases and good cases

When repeated problems exist, use this compact pattern:

| Bad case                        | Why it fails                      | Good case next time           |
| ------------------------------- | --------------------------------- | ----------------------------- |
| Observable behavior or artifact | Decision, trust, or rework impact | Specific replacement behavior |

Examples:

- Bad: "The AI calculated this." Good: show the source, unit, formula, assumptions, sanity check, and own the number.
- Bad: collect many facts without answering the decision. Good: lead with the recommendation and connect evidence to it.
- Bad: reveal missing work in the final meeting. Good: flag the gap early with its impact and recovery plan.
- Bad: say "understood" without restating the task. Good: briefly restate the result, deliverable, and scope before starting.

Critique work and method, not identity.

## Prepare the report

Default to a short report:

1. **Conclusion** — the answer or current verdict.
2. **Manager expectation** — what the work must accomplish.
3. **Current status** — what is confirmed, missing, or off track.
4. **Next actions** — no more than seven prioritized actions unless complexity requires more.
5. **Meeting narrative** — how to explain the result and what decision or help to request.

Prepare concise answers to likely questions:

- How do you know?
- What is the source?
- What is the formula or test method?
- What remains unknown?
- What would change the recommendation?
- Why not the alternative?

Use truthful language:

- "Confirmed: A. Inferred: B. Unknown: C."
- "The earlier number was invalid; this is the corrected source and calculation."
- "This gap does not change the recommendation because..."
- "I cannot support that claim yet; the next verification is..."

Never use "the AI said so" as evidence.

## Improve meeting bandwidth

Analyze whether the next meeting is likely to create decisions, information gain, and executable actions. Identify low-value patterns such as:

- reading or discovering basic facts live that should have been pre-read;
- presenting chronology or broad research instead of the core conclusion;
- repeating the same question because the evidence is still missing;
- letting the manager redo calculations, problem decomposition, or architecture during the review;
- debating unsupported guesses;
- mixing status review, brainstorming, coaching, and performance feedback without a clear transition;
- continuing after a decision-critical artifact is clearly not ready;
- leaving without a decision, owner, next action, or acceptance condition.

Recommend a higher-bandwidth alternative:

- circulate the decisive artifact before the meeting when useful;
- open with the conclusion, evidence confidence, and decision needed;
- discuss only disagreements, risks, unknowns, and choices that need synchronous attention;
- move background detail and exploratory branches to documents or follow-up work;
- stop live rework once the missing prerequisite is clear;
- close with the decision, changed assumptions, owner, next output, and timing.

Protect meeting quality without hiding failure. If the work is not ready, say so early and convert the remaining time into a short correction decision rather than a long low-nutrition debate.

## Communicate in a way that makes sense

Help the employee keep the conversation truthful and efficient:

- answer the exact question before adding context;
- separate confirmed fact, inference, recommendation, and request;
- use one concise model or table when it replaces repeated explanation;
- ask for clarification when the decision target materially changes;
- do not agree merely to reduce pressure;
- correct an error directly and continue with the corrected model;
- surface workload or scope conflict as a delivery trade-off, not an emotional complaint;
- end exploratory branches that no longer affect the decision.

The goal is not to sound polished. The goal is to make the shared model more accurate and move the work forward.

## Use optional checkpoints only when helpful

For long or risky work, optionally suggest a few natural checkpoints such as:

- confirm the question before deep research;
- review evidence before writing the recommendation;
- rehearse the report before the meeting.

Do not require named gates, scores, or forms for ordinary work. The goal is earlier correction, not process ceremony.

## Quality rules

- Lead with the verdict.
- Prefer one defensible recommendation over unranked possibilities.
- Separate meeting claims, verified facts, inferences, and proposals.
- Check consequential numbers and experiments deeply.
- Expose important unknowns early.
- Judge work by whether it supports the decision, not by effort or formatting.
- Judge meeting quality by decisions, information gain, and executable next actions, not duration or intensity.
- Keep ownership with the employee even when AI or subagents assist.
