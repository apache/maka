---
name: understanding-first-report
description: Reconstruct and report long-running or multi-turn research, architecture questions, reviews, decisions, completion results, and status as a clear, self-contained brief. Use when a reader must re-enter earlier context, understand the real question and its relationships, distinguish verified facts from judgment and open evidence, or make a decision without reconstructing the work log. Quote the relevant original user wording before substantive analysis, keep one coherent main line, use spatial diagrams when relationships matter, and finish with an explicit decision boundary and practical next step.
---

# Understanding-First Report

## Purpose and boundary

Turn completed or partially completed work into a low-friction cognitive handoff.

This skill governs reporting only. It does not govern planning, progress updates, approvals, tool execution, scheduling, or coordination while work is in progress.

The report should let the reader recover:

- **Memory**: what they asked and which earlier context still matters.
- **Meaning**: the main question, conflict, and deeper need.
- **Trust**: what is verified, inferred, conflicting, stale, or open.
- **Control**: what the evidence supports, what the report recommends, and what remains the human decision.

## Five reporting qualities

Treat these as observable acceptance criteria:

```text
Understand implied intent   -> The reader rarely repairs the frame.
Read the moment             -> Depth and format fit the current need.
Be clear and complete       -> The judgment is easy to find and use.
Be warm, not flattering    -> The report has judgment and preserves choice.
Write one coherent line     -> Structure serves meaning, not a template.
```

When these qualities conflict with richer formatting, protect the qualities. A polished report still fails if the reader must correct its interpretation, hunt for the conclusion, or rewrite the answer.

These qualities reduce six kinds of reader friction:

```text
re-entry · meaning · navigation
verification · cleanup · decision
```

## Choose the smallest useful report mode

Use the smallest shape that completes the handoff.

- **Short decision**: one self-contained question, one judgment, only the reason and caveat that change the choice.
- **Re-entry report**: relevant original asks, accepted choices, meaningful changes, current question, and current judgment.
- **Decision report**: real choice, central contradiction, recommendation, evidence, risk, and reversal condition.
- **Research-status report**: what is clear, partial, conflicting, stale, or open; the smallest check that unlocks the decision.
- **Review report**: findings ranked by consequence, with each material issue connected to a risk, decision, or fix.
- **Completion report**: requested outcome, what now exists, verification, remaining limits, and the next useful action.

These are lenses, not required headings. Combine modes only when the reader genuinely needs both.

## Start with the original question

Before substantive analysis, quote the relevant user wording. This restores continuity before summary, interpretation, or judgment.

- Quote the current request when it is self-contained.
- When earlier turns change the meaning, quote those user turns as well.
- Keep relevant quotes in time order so scope changes remain visible.
- Quote the user, not an earlier assistant summary.
- Preserve wording, spelling, code, links, and emphasis.
- When the relevant wording is roughly 1,000 characters or less, prefer quoting it in full.
- For longer material, omit only non-decision-bearing passages and mark every omission explicitly.
- If earlier wording is unavailable, state the gap rather than inventing continuity.

A compact shape is enough:

```markdown
> **Earlier request**
> Relevant original wording.
>
> **Scope change**
> Wording that changed the task.
>
> **Current request**
> The question this report answers now.
```

After the quote, provide a short synthesis. Do not replay the transcript.

## Show the report delta

For repeated or long-running work, emphasize why the new report matters now:

```text
STILL TRUE        CHANGED         INVALIDATED
accepted facts    moved scope     reversed assumption

NEW               STILL OPEN
new evidence      remaining blocker
```

Include only deltas that change context, confidence, choice, risk, or action. Do not reopen an accepted decision unless new evidence invalidates it.

## Reconstruct the problem before presenting the answer

First inventory the explicit questions. Then identify:

- the one main question;
- support questions that explain how or why;
- constraints that limit the answer;
- relationships such as dependency, conflict, ownership, containment, time, or evidence;
- the deeper need that makes the questions matter.

A list prevents omissions. A spatial map exposes structure.

```text
Earlier context                 Current questions
┌──────────────────┐          ┌──────────────────┐
│ accepted choices │          │ explicit asks    │
│ relevant changes │          │ current limits   │
└─────────┬────────┘          └─────────┬────────┘
          └────────────┬────────────────┘
                       ▼
              ┌──────────────────┐
              │ Core conflict    │
              └────────┬─────────┘
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
     deeper question           unmet need
```

Treat a deeper need as inference until the conversation or evidence supports it. If an uncertain inference would change the answer, show the fork.

Useful insight changes the reader's mental model. It may reveal:

- a hidden owner or source of truth;
- two mixed layers or axes;
- a missing rule or contract;
- why the obvious answer fails;
- a trade-off that cannot be removed;
- the fact that would reverse the recommendation.

Do not force novelty. A simple, well-supported answer is better than artificial depth.

## Keep one main line

Organize the material into three lanes:

- **Main line**: real question, central conflict, judgment, and action.
- **Support line**: mechanism, decisive evidence, and main risk.
- **Detail line**: versions, history, edge cases, and optional examples.

The main line should remain understandable without the detail line. Remove material that does not change the mental model, decision, risk, or next action.

For a substantial decision report, the first screen should usually reveal:

```text
original ask · current frame · verdict or readiness state
```

## Calibrate evidence before giving a verdict

Use only the evidence labels that help the decision:

- **Clear**: verified by a source, code, test, or direct observation.
- **Partial**: the main path is known but a material case is unchecked.
- **Open**: evidence is not sufficient for a conclusion.
- **Inference**: reasoned from verified facts rather than directly observed.
- **Conflict**: sources, versions, code paths, or goals disagree.
- **May be stale**: older evidence could have changed.

If the main question is not ready:

- answer the parts that are ready;
- name the missing or conflicting fact;
- explain why it blocks the rest;
- identify the smallest next check;
- state which recommendation remains provisional.

Do not let visual confidence or smooth prose make weak evidence look settled.

When evidence is ready, give one clear judgment with its confidence, central contradiction, and boundary. Include alternatives only when they materially change cost, ownership, risk, or the decision.

## Preserve human decision rights

Separate basis, judgment, and choice:

```text
┌──────────────────┐      ┌──────────────────┐
│ Verified basis   │─────>│ Report judgment  │
│ fact · test · gap│      │ reason + limit   │
└──────────────────┘      └────────┬─────────┘
                                   │
                     ┌─────────────┴─────────────┐
                     ▼                           ▼
              human choice               reversal condition
              when one remains           what would change it
```

- Do not present a recommendation as though the source itself made the decision.
- When the human still owns a material choice, state the choice and its trade-off.
- When evidence settles the question, do not manufacture a false choice merely to sound deferential.
- Name the reversal condition when the judgment depends on an assumption, unchecked path, scale threshold, or future fact.
- Do not use visual weight or tone to make weak evidence feel stronger.

## Explain the mechanism visibly

Use a visual only when it replaces explanation or makes a relationship materially easier to see.

Good uses include:

- **Problem geometry**: dependencies, conflicts, ownership, or mixed axes.
- **Mechanism**: the actual path, responsibility boundary, or state owner.
- **Lifecycle**: pause, retry, resume, failure, migration, or staged adoption.
- **Choice**: branches that materially change cost, risk, or ownership.
- **Exact mapping**: repeated field, event, or responsibility mappings.

One diagram should answer one question. Prefer two small diagrams over one overloaded picture.

Use spatial composition deliberately:

- left and right for peers, alternatives, producer and consumer, or before and after;
- top and bottom for real dependency or lifecycle;
- center and outward for one owner serving several concerns;
- nested regions only for true containment;
- labeled arrows for a named relationship.

Avoid long vertical chains. Keep roughly three sequential nodes on one axis, then group, branch, or split the visual.

Do not place standalone arrow blocks between ordinary sections. Document order already provides vertical flow.

## Use Markdown as a semantic UI

Natural prose is the default. Add structure when it lowers navigation or verification cost.

### Headings and lists

- Use level-two headings for major turns in the argument.
- Use level-three headings for a local decision, owner, contradiction, risk, or scenario.
- Use deeper headings sparingly.
- Use hyphen bullets for true siblings.
- Use numbered lists only for real sequence or rank.
- Avoid more than one nested bullet level in normal chat.
- Prefer another visual form over a Markdown table unless a table is clearly the smallest accurate representation.

### Blocks

- Use a blockquote for the user's wording or a short source capsule.
- Use a fenced text block for diagrams, mappings, constraints, logs, or exact output.
- Use a truthful language tag for verified code.
- Use a syntax-highlighted language tag for pseudocode when its grammar helps explain the idea.
- Keep source links clickable outside code fences.

Label provenance immediately above code:

- Official usage with version and source.
- Minimal adaptation of official usage.
- Source relationship excerpt with commit and path.
- Pseudocode: recommended design, not an existing API.

Never combine verified source code and recommended design into a fictional official API.

### Emphasis and emoji

Bold only short plain-text anchors. Keep edge punctuation and emoji outside the bold markers.

```diff
- **Key judgment:** Keep one state owner.
+ 🎯 **Key judgment**: Keep one state owner.
```

A small, stable emoji vocabulary may improve navigation:

- 🧭 question or orientation;
- 🎯 judgment or decision;
- ⚙️ mechanism;
- 🔎 evidence;
- 💡 insight;
- ⚠️ risk or conflict;
- ✅ action or completion;
- 🧩 boundary or composition.

Emoji is optional. It never replaces a label, severity, owner, or status. Avoid emoji inside fixed-width diagrams unless alignment is checked.

## Protect attention

Design the main path for about two to three minutes of reading when the material allows it. Treat this as an attention target, not a quota.

Useful editing heuristics:

- one purpose per paragraph;
- one claim per bullet;
- three to six bullets in a normal cluster;
- one relationship per diagram;
- five to fifteen lines for code that proves an architectural seam;
- a few decisive facts rather than a source catalog;
- one verdict, deepened by mechanism and evidence rather than repeated.

When over budget, cut in this order:

```text
vendor inventory
-> secondary history
-> repeated examples
-> edge cases that do not change the choice
-> implementation detail that can wait
```

Protect the question, real decision, mechanism, decisive evidence, main risk, and next action.

## Write with warmth and judgment

Write like a thoughtful colleague: calm, attentive, candid, and kind.

- Acknowledge a real difficulty, correction, or stake only when it helps the reader enter the answer.
- Give a reason when agreeing.
- Push back clearly and constructively when disagreeing.
- State uncertainty plainly, then provide the useful next check.
- Prefer common developer words over consultant or academic language.
- Preserve exact project terms, identifiers, commands, logs, schemas, and quotations.
- Let sentence rhythm and personality remain; brevity should not become telegraph prose.

Warmth comes from accurate listening, fair criticism, honest uncertainty, and useful action. It is not praise.

Avoid automatic compliments, therapy language, repeated apologies, canned empathy, performative certainty, and long emotional prefaces.

## Keep the report self-contained

The chat answer should carry the main question, verdict or readiness state, mechanism, decisive evidence, risk, and next action.

Create a separate artifact only when the user requests it, the workflow requires it, or deep evidence cannot be preserved responsibly in chat. A linked file may be an appendix; it must not replace the report.

Do not publish or attach raw research notes, source catalogs, private discussion, internal reasoning, or conversation history unless the user explicitly requests that exact artifact. Quote only the user wording needed to understand the current report.

## Finish with a useful action

End with:

- the recommendation or completed result;
- the main responsibility boundary when relevant;
- the smallest useful next step;
- an acceptance condition when a check or staged path is proposed.

If the user requested a report rather than authorization to act, keep the next step as a recommendation. Reporting does not authorize an external change.

## Failure signals

- **Lost context**: answers only the latest message when earlier turns still change the scope.
- **Transcript replay**: restores context by reproducing the conversation instead of synthesizing it.
- **Flat questions**: treats every question as equally important.
- **False confidence**: writes partial, inferred, conflicting, or old evidence as settled fact.
- **Work-log first**: leads with tools, searches, or chronology before the problem and decision.
- **Pretty but shallow**: polished Markdown without a visible conflict, mechanism, or useful insight.
- **Mode mismatch**: gives a full research brief to a short decision or omits re-entry from a long-running report.
- **Template lock-in**: fills every suggested section even when a simpler shape would work.
- **Decision blur**: merges verified facts, report judgment, and human choice into one voice.
- **Dense or over-built**: uses long prose, deep headings, repeated arrows, or too many boxes.
- **Cold or ingratiating voice**: becomes a status machine, empty praise, or scripted empathy.
- **Artifact substitution**: points to a file instead of delivering the report.
- **Privacy spill**: exposes internal notes or irrelevant conversation history.

When a failure signal appears, simplify the report and return to the reader's real decision.

## Truth and exactness boundaries

These are firm because crossing them creates a false or unsafe report:

- place relevant original user wording before substantive analysis;
- mark omitted quoted material explicitly;
- preserve exact code, commands, paths, logs, schemas, quotations, and machine-readable output;
- keep factual claims traceable;
- label pseudocode as recommended design rather than shipped API;
- distinguish verified facts from inference, open questions, conflicts, and stale evidence;
- state missing context instead of inventing continuity;
- keep internal notes and irrelevant private context out of public artifacts;
- keep the main answer in chat rather than substituting a document.

## Final reflection

Before sending, ask:

- Did I quote only the relevant original wording?
- What is the one main question?
- Which earlier facts or choices still change it?
- What is still true, changed, invalidated, new, or open?
- Is the verdict supported, or would one more check materially change it?
- Can the reader see the conflict and mechanism without reading the work log?
- Are facts, judgment, human choice, and reversal condition distinct where needed?
- Did I choose the smallest report mode that completes the handoff?
- Does each visual reveal a relationship rather than decorate the page?
- Which reader cost remains too high: re-entry, meaning, navigation, verification, cleanup, or decision?
- Does the report end with a clearer mental model and a practical next step?

Use these prompts as aids to judgment, not as a visible checklist.
