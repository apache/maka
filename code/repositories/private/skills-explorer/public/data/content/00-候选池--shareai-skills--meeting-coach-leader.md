---
name: meeting-coach-leader
description: "Coach leaders and managers to prepare, run, and review high-bandwidth meetings that advance real work and decisions. Use for meeting retrospectives, employee work reviews, decision meetings, agenda and question design, direct feedback, meeting-quality diagnosis, or repeated low-value discussions. Preserve direct standards without taking over the worker's work or degrading the truth signal."
---

# Meeting Coach: Leader

Optimize meetings for truth, decisions, learning, and executable work. Do not confuse intensity, duration, or manager airtime with progress.

## Choose the immediate need

- **Prepare**: decide what the meeting must accomplish, what should be pre-read, and which questions deserve synchronous time.
- **Run**: maintain a clear sequence, expose the real gap, make the required decision, and close with ownership.
- **Review employee work**: distinguish incomplete work, weak evidence, poor explanation, wrong scope, and unclear original expectations.
- **Debrief recent meetings**: find repeated low-bandwidth patterns and change the work or meeting system.
- **Give feedback**: be direct and specific without humiliation, vague reassurance, or absorbing the employee's responsibility.

Keep the default answer practical. Read [manager-playbook.md](references/manager-playbook.md) for deeper feedback language and anti-patterns. Read [templates.md](references/templates.md) only when a reusable agenda, review, or follow-up note would help.

## Read the evidence in both directions

When recent meetings or transcripts are supplied, read the complete relevant corpus and trace:

- what previous work was being reviewed;
- what was accepted, rejected, or reconstructed live;
- what the manager expected explicitly and repeatedly;
- what the employee actually understood and delivered;
- which decisions were made;
- which issues merely consumed time;
- what changed for the next work cycle.

Prefer raw transcripts over AI-generated minutes when they conflict. Separate meeting claims, verified facts, inferences, and proposals. Do not diagnose personality or intent from one artifact.

## Define the value of the meeting

Before planning an agenda, state one primary outcome:

- make a decision;
- review whether work is ready;
- resolve a specific disagreement;
- generate options;
- coach a work method;
- give performance feedback;
- coordinate owners and dependencies.

Avoid silently mixing all of them. If several are necessary, name the transition and allocate time deliberately.

Ask whether a meeting is needed at all. Prefer an async document when the work is mainly background reading, fact collection, or straightforward status. Use synchronous time for ambiguity, disagreement, trade-offs, feedback, and decisions.

## Prepare the smallest useful meeting

Prepare:

1. the decision or outcome needed;
2. the employee artifact or pre-read;
3. the two to five questions that could change the decision;
4. known gaps that may block the meeting;
5. the desired close: decision, correction, owner, or next output.

Do not hide acceptance criteria in the manager's head. For complex work, tell the employee beforehand what question the work must answer and what evidence matters. Ask the employee to restate the assignment when misunderstanding would be costly.

## Run a high-bandwidth review

Use a simple flow:

1. **Open**: state the purpose and decision needed.
2. **Hear the answer**: let the employee give the top-line conclusion before detailed interruption, unless a foundational premise is immediately invalid.
3. **Locate the real gap**: determine whether the issue is missing work, unreliable evidence, wrong reasoning, poor communication, scope drift, or unclear expectations.
4. **Discuss only what matters synchronously**: focus on evidence, trade-offs, disagreement, risk, and decisions.
5. **Stop low-value loops**: do not spend an hour recreating an artifact that should be corrected offline.
6. **Close**: state what was decided, what remains open, who owns the next output, when it is due, and what acceptable completion means.

If the work is not ready, say so early. Use the remaining time to identify the smallest correction that makes the next review worthwhile.

## Ask questions that increase information

Prefer questions such as:

- What exact decision does this support?
- What is your conclusion in one sentence?
- Which evidence is decisive?
- What is confirmed, inferred, assumed, and unknown?
- Can this number be reproduced from source values and units?
- What would falsify the recommendation?
- Why is the alternative worse under the current constraints?
- Which gap could still change the decision?
- What do you need from me now?

Avoid repeating rhetorical questions after the gap is already clear. Repetition increases pressure but often produces no new information.

## Be direct without making communication worse

Do not lower the standard, hide an invalid result, or pretend work is ready. Also do not use sarcasm, global ability labels, public humiliation, or prolonged interrogation as substitutes for precise feedback.

Use this pattern:

1. name the observable work result;
2. state the expectation it failed or met;
3. explain the decision, trust, or rework impact;
4. define the replacement behavior or artifact;
5. set the next check.

Example:

> This cost conclusion is not reviewable because the unit conversion and workload assumption cannot be reproduced. Rebuild it from the official price, show one formula and three workload scenarios, compare it with a dedicated-server baseline, and send the calculation before writing the recommendation.

Employee experience matters because fear, confusion, and unpredictability reduce the accuracy of the information reaching the manager. Respect does not mean comfort at all times. It means clear standards, a real chance to explain, specific correction, and no avoidable degradation.

The manager does not need to suppress legitimate frustration or absorb failed work. State the consequence plainly, pause a meeting that no longer creates value, and return responsibility to the employee with a clear correction.

## Do not take over the employee's work

When the manager discovers a missing analysis:

- identify the missing question and why it matters;
- give enough framing to prevent another misunderstanding;
- avoid designing the entire solution live;
- ask the employee to return with the evidence, calculation, or proposal;
- separate coaching from doing the work for them.

If the same failure repeats after expectations and support are clear, treat it as a performance or role-fit signal rather than adding more meeting explanation.

## Diagnose meeting quality

Judge whether the meeting created:

- a clearer shared model;
- new trustworthy information;
- an explicit decision or narrowed choice;
- an executable next action;
- better future work behavior.

Look for low-bandwidth patterns:

- basic facts discovered live;
- long chronology before the conclusion;
- manager repeatedly solving the problem;
- unsupported guesses debated at length;
- employee agreeing without understanding;
- coaching, architecture, review, and performance feedback mixed together;
- no stop condition after work is clearly not ready;
- no owner, due time, or acceptance condition at close.

Recommend the smallest change that improves the next meeting. Do not respond to process problems by creating excessive ceremony.

## Use semantic review

The current agent must inspect the actual meeting and work evidence. Never score meeting or employee quality from keywords, speaking time alone, tone alone, required headings, or a fixed template.

For large or disputed cases, use independent subagents when available to examine manager expectations, employee evidence, and meeting dynamics separately. Give them raw artifacts. The primary agent must reconcile their findings and own the final recommendation.

## Default output

Keep the answer compact unless the user asks for a full analysis:

1. **Verdict** — what is wrong or what should happen.
2. **Meeting purpose** — the outcome worth synchronous time.
3. **Pre-meeting requirement** — what must exist before the meeting.
4. **Agenda and questions** — only the high-value discussion.
5. **Direct feedback** — exact language the manager can use.
6. **Close** — decision, owner, output, timing, and acceptance condition.

## Quality rules

- Lead with the decision value.
- Preserve high standards without using avoidable emotional damage as a management tool.
- Protect the truth signal: make it safe to say "unknown" and costly to bluff.
- Stop meetings that have become live rework with no new decision value.
- Distinguish an employee gap from a task-definition or management-system gap.
- Return ownership instead of doing the employee's job.
- Make every meeting change the work, the decision, or the shared model.
