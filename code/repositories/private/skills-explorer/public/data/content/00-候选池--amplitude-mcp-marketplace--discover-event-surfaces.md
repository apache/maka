---
name: discover-event-surfaces
description: >
  Given a change_brief YAML (output from diff-intake), generates an exhaustive
  list of candidate analytics events to instrument. Takes the perspective of an
  engineer with a PM mindset — surfaces everything worth considering so a PM can
  decide what actually matters. Use this as step 2 of the analytics
  instrumentation workflow, immediately after diff-intake produces a
  change_brief. Trigger whenever a user has a change_brief YAML and wants to
  know what analytics events to add, or asks "what should I track for this PR",
  "what events should I instrument", "generate event candidates", or any
  request to surface analytics coverage gaps for a code change.
---

# discover-event-surfaces

You are step 2 of the analytics instrumentation workflow. Read a `change_brief`
YAML and produce an exhaustive candidate list of analytics events — named well,
organized by category, and ready for PM review.

Think like an engineer who ships the feature AND cares about whether it
succeeds. Generate events that answer product/business questions, not events
that mirror implementation details. Aim for **breadth and quality** — a
downstream skill will narrow the list.

Read the `taxonomy` skill at `../taxonomy/SKILL.md` to understand core
analytics philosophy and naming standards.

---

## 1. Parse the change_brief

- `classification.analytics_scope` — if `none`, stop and tell the user there's nothing to instrument.
- `summary` — one-line description of the change.
- `user_facing_changes` — primary signal. Each entry = something a user can now do or see differently.
- `surfaces.components` — modified UI components; where interactions happen.
- `file_summary_map` — read summaries for files in `surfaces` or touching user-facing logic. Skip tests/config/tooling.

## 2. Scan the codebase and map user flows

Before generating any events, build a concrete understanding of how users move
through the feature. The change_brief gives you file paths and summaries — now
read the actual code to trace the full journey.

### What to read

- Every file listed in `surfaces.components` — read them fully.
- Files from `file_summary_map` that touch user-facing logic (skip tests, config,
  tooling).
- Follow imports and references one level out: if a component calls a hook, API
  function, or navigates to another route, read that target file too. This is how
  you discover steps the diff didn't touch but that are part of the same flow.

### What to look for

Trace the path a user takes from entry to outcome:

- **Entry points** — how does the user arrive? Route definitions, navigation
  calls, menu items, links, feature flag gates.
- **Interaction sequence** — what does the user do step by step? Form fills,
  selections, confirmations, uploads. Look at handler wiring (`onClick`,
  `onSubmit`, `onChange`) and what state they mutate.
- **Async boundaries** — API calls, mutations, server actions. These are where
  "attempted" becomes "succeeded" or "failed."
- **Terminal states** — success confirmations, error handling, redirects,
  completion screens.
- **Branching paths** — conditionals that route users to different outcomes
  (e.g., free vs paid, first-time vs returning).

### Produce a funnel hypothesis

Synthesize what you found into one or more funnels — ordered sequences of user
steps from entry to outcome. Each funnel should have:

- A descriptive name (e.g., "Property extraction flow", "Onboarding wizard")
- The ordered steps, each with the file and function/handler where it happens
- Which step is the **start** and which is the **end**

Not every change has a funnel. Single-action features (a toggle, a one-click
export) don't need one — just note that there's no multi-step flow. But when a
flow exists, mapping it here is what allows you to confidently assign funnel
start/end as critical later.

Keep the hypothesis grounded in code you actually read. Don't invent steps you
didn't see evidence for.

## 3. Determine naming conventions and fetch existing events

Invoke `discover-analytics-patterns` and use its
`event_naming_convention` and `property_naming_convention` outputs. That skill
owns the naming-resolution procedure and precedence order. Do not redefine it
here.

Before generating candidates, pull the project's existing event taxonomy so you can
avoid duplicates and match the naming convention already in use.

### Resolve the project

If the change_brief includes an Amplitude `projectId`, use it directly. Otherwise,
call `get_amplitude_context` to resolve the project name or ask the user which project to
target. You need a `projectId` for the next call.

### Pull existing events

Inspect the connected catalog and use its current taxonomy event reader with
the resolved `projectId`. Follow only its advertised schema. When it supports
caller attribution, identify this skill with the `name` from its YAML
frontmatter. No cursor is needed—the first page is enough for pattern
detection. Request the event name, category, and description fields when its
schema supports field selection, then use the returned field names.

### Build naming references and an existing event index

1. **Existing event index** — Collect all `eventType` values into a set. You'll
   check candidates against this set in step 4 to avoid proposing events that are
   already tracked. An event is a duplicate if its semantic meaning matches an
   existing `eventType`, not just its exact string — e.g., if `Subscription Upgraded`
   exists, don't propose `Plan Upgraded` for the same action.

## 4. Generate candidate events

Start from the funnel hypothesis. If you identified funnels in step 2, generate
events for the funnel start and end first — these are your anchors. Then fill in
candidates for intermediate steps and non-funnel surfaces.

For each `user_facing_change`, ask: _"If a user does this — what outcomes would a PM want to know about?"_

Generate from four categories (ordered by priority):

| Category             | What it captures                                                                                  | When to include                                      |
| -------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **business_outcome** | Revenue, retention, growth actions (purchases, subscription changes, conversion gates)            | Change touches monetization or retention surface     |
| **user_journey**     | Meaningful state transitions (workflow completed, feature activated, onboarding finished)         | Change introduces or alters a user journey step      |
| **feature_success**  | The "it worked" moment — confirmed outcome, not button click (document created, report generated) | Any new or materially changed feature                |
| **friction_failure** | Where users fail, get stuck, or give up (errors, empty states, abandonment)                       | Complex multi-step interactions or error-prone flows |

### Deduplicate against existing events

After generating candidates, check each one against the **existing event index**
you built in step 3. For each candidate:

- **Exact match** — the `eventType` already exists verbatim. Drop the candidate.
- **Semantic match** — a different name tracks the same user action or outcome
  (e.g., you proposed `Plan Upgraded` but `Subscription Upgraded` already exists
  for the same action). Drop the candidate.
- **Partial overlap** — an existing event covers a broader action that subsumes
  your candidate (e.g., `Checkout Completed` already exists and your candidate
  `Payment Submitted` fires at the same moment). Drop unless the candidate captures
  meaningfully different information.

If you drop a candidate because it already exists, note it in a
`already_tracked` list in the output so the user can see what's covered.

## 5. Quality filter

Every candidate must pass all three:

1. **Decision-useful** — A PM could make a product decision from this alone, without five other events for context.
2. **Outcome-focused** — Captures that something _happened_, not that the user _attempted_ it. `Property Extracted` > `Extract Button Clicked`. Prefer confirmed outcomes; form submissions are acceptable when no server confirmation exists.
3. **Stable across redesigns** — Named around the business/product concept, not the UI element. If renaming a modal would make the event name stale, it's too coupled.

**Cut:** raw clicks/hovers without outcomes, internal technical actions (API callbacks, state updates), UI-versioned names (`modal_v2_submit`), sub-step-level granularity.

## 6. Name events

Use the naming conventions returned by `discover-analytics-patterns`.
New events should look like they belong with the rest of the instrumentation:
same casing, same word order, same delimiters, same prefix patterns, and the
same level of specificity.

If you later need to suggest property names in rationale or instrumentation
hints, use the `property_naming_convention` returned by
`discover-analytics-patterns`.

In all cases, use product-domain subjects (Property, User, Document), not code
names (PropertyItem, ActionStore).

| Good (Title Case convention) | Bad                        |
| ---------------------------- | -------------------------- |
| `Property Extracted`         | `extract_property_clicked` |
| `Extract Type Configured`    | `type_dropdown_changed`    |
| `Property Creation Failed`   | `500_error_new_property`   |

## 7. Determine file and instrumentation point

For each candidate, use `file_summary_map` and `surfaces.components` to identify:

- **`file`** — the source file where the tracking call belongs. Prefer the file closest to where the outcome is confirmed (not where the user initiates the action). Usually a component file from `surfaces.components` or a hook where an async operation resolves.
- **`instrumentation`** — 1-2 sentences: _when_ it fires (after what condition/callback/state transition) and _how_ it's wired (which function/handler to place it in). Reference actual function names from file summaries so an engineer can find the right line.

## 8. Deepen understanding, then prioritize

For each candidate, first work through these two fields — they force you to think concretely about the event's value before scoring it:

- **`analysis_recipe`** — Describe the specific chart, funnel, or query an analyst would build with this event. Be concrete: mention the visualization type, segmentation dimensions, and any other events to combine with. e.g., _"Weekly funnel: Panel Opened → Extract Type Selected → Property Extracted, segmented by extractType. Alert if completion rate drops below 50%."_
- **`stakeholder_narrative`** — Write a sentence that a PM could drop into a quarterly review or board deck, using this event's data. Imagine the metric already exists and write the story it tells. e.g., _"68% of users who try extraction complete it on the first attempt, up from 45% last quarter."_ If you can't imagine a compelling slide sentence, the event probably isn't worth instrumenting.

Now, with that context fresh, assign a **priority**:

| Priority         | Meaning                                                                                                            | Guidance                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| **3** (critical) | You would block a release if this event were missing. It answers a question the team _will_ ask in the first week. | Reserve for events that directly measure whether the feature succeeded or failed. Most changes produce only 1-2 critical events. |
| **2** (useful)   | Adds real analytical value but the feature can ship without it. Worth adding if instrumentation cost is low.       | Segmentation dimensions, secondary workflows, configuration choices.                                                             |
| **1** (optional) | Nice-to-have. Only instrument if the team has bandwidth and a specific hypothesis to test.                         | Edge-case failures, exploratory engagement signals, discoverability metrics.                                                     |

**Funnel events deserve special attention.** When a change introduces or modifies a multi-step process (checkout flow, onboarding wizard, data import pipeline), the PM's first question will be "where are users dropping off?" A gap between funnel start and funnel end with no visibility in between is a blind spot that can hide serious product problems — if engagement craters at step 2 of 5, the team needs to know, not guess.

**Funnel start and funnel end events are always critical (priority 3).** Without the bookends, you can't measure conversion rate — the single most important metric for any funnel. These two events are non-negotiable regardless of funnel length or complexity.

To decide how many _intermediate_ funnel events to mark critical, gauge the length and complexity of the funnel:

- **Short process (2-3 steps, single page):** The start and end events are enough. Don't instrument every micro-step in a simple flow.
- **Medium process (3-5 steps, possibly spanning pages):** Add one intermediate event at the most likely drop-off point — typically where the user commits effort (fills a form, makes a key selection, uploads a file).
- **Long process (5+ steps, multi-page or wizard-style):** 2-3 intermediate events at natural phase boundaries. Think "started → configured → submitted → confirmed" rather than tracking every field interaction.

Be selective with intermediate events. Every funnel event you mark critical is one more thing an engineer must implement and a PM must monitor. If you're unsure whether an intermediate step is worth tracking, it probably isn't — the start and end events will reveal whether there's a problem, and the team can always add granularity later once they see where drop-off is high.

Less is more. A focused set of critical events that actually get dashboarded beats a sprawling list nobody looks at. When in doubt, downgrade — it's easier to add an event later than to remove one that's already in dashboards.

## 9. Emit YAML output

Output only the YAML block — no surrounding prose.

```yaml
event_candidates:
  source_summary: "<from change_brief.summary>"
  analytics_scope: "<from change_brief.classification.analytics_scope>"
  event_naming_convention: "<from MCP if clear, otherwise codebase instrumentation, otherwise taxonomy skill>"
  property_naming_convention: "<from MCP if clear, otherwise codebase instrumentation, otherwise taxonomy skill>"

  already_tracked: # omit if no duplicates found
    - existing_event: "Subscription Upgraded"
      candidate_dropped: "Plan Upgraded"
      reason: "Same action — existing event already tracks plan/subscription upgrades."

  funnels: # omit if no multi-step flows found
    - name: "Descriptive funnel name"
      steps:
        - step: "Step description"
          file: "src/components/Foo.tsx"
          function: "handleOpen"
          role: start # start | intermediate | end
        - step: "Next step"
          file: "src/components/Bar.tsx"
          function: "onSubmit"
          role: intermediate
        - step: "Final step"
          file: "src/hooks/useSave.ts"
          function: "onSuccess"
          role: end

  candidates:
    - name: "Event Name Here"
      category: feature_success # business_outcome | user_journey | feature_success | friction_failure
      rationale: "What PM question this answers."
      analysis_recipe: "Weekly trend of completions; funnel from Panel Opened → Extract Type Selected → Event Name, segmented by extract type."
      stakeholder_narrative: "Feature X adoption reached 40% of active users within two weeks of launch, exceeding our 25% target."
      priority: 3 # 3 = critical, 2 = useful, 1 = optional
      funnel: "Funnel name" # which funnel this belongs to, if any
      funnel_role: start # start | intermediate | end — omit if not part of a funnel
      surface: "ComponentName" # from surfaces.components
      file: "src/components/Foo/Bar.tsx"
      instrumentation: "Fire after the async save resolves, inside onSuccess of useExtract(). Pass result status."

    - name: "Another Event"
      category: user_journey
      rationale: "..."
      analysis_recipe: "..."
      stakeholder_narrative: "..."
      priority: 2
      surface: "..."
      file: "..."
      instrumentation: "..."
```

Order: higher categories first, most impactful within each category first.

---

## Example

**Input excerpt:**

```yaml
user_facing_changes:
  - "Users can now select Extract Type (Text or Attribute) in the PropertyItem panel"
surfaces:
  components:
    - name: PropertyItem
      change: modified
```

**Good candidates:**

```yaml
- name: "Property Extracted"
  category: feature_success
  rationale: "Core adoption signal — tells PMs whether the extract workflow completes."
  analysis_recipe: "Weekly funnel: Panel Opened → Extract Type Selected → Property Extracted, segmented by extractType. Alert if completion rate drops below 50%."
  stakeholder_narrative: "72% of users who open a property panel complete an extraction, up from 0% before this release — validating the new extract workflow."
  priority: 3
  surface: "PropertyItem"
  file: "src/components/PropertiesPanel/PropertyItem.tsx"
  instrumentation: "Fire after extract resolves successfully in onSuccess handler. Include extractType (TEXT or ATTRIBUTE)."

- name: "Extract Type Selected"
  category: feature_success
  rationale: "Shows which mode users prefer — informs investment in Attribute mode."
  analysis_recipe: "Pie chart of Text vs Attribute selections over 30 days. Combine with Property Extracted to get per-mode completion rate."
  stakeholder_narrative: "85% of extractions use Text mode vs 15% Attribute — we should double down on Text UX before expanding Attribute capabilities."
  priority: 2
  surface: "PropertyItem"
  file: "src/components/PropertiesPanel/PropertyItem.tsx"
  instrumentation: "Fire in onChange of Extract Type select, passing new value."

- name: "Property Extraction Failed"
  category: friction_failure
  rationale: "Surfaces where the extract workflow breaks for reliability prioritization."
  analysis_recipe: "Error rate chart: Property Extraction Failed / (Property Extracted + Property Extraction Failed), grouped by error reason. Alert on spikes."
  stakeholder_narrative: "Extraction failure rate dropped from 12% to 3% after the v2 error-handling patch — users are hitting fewer dead ends."
  priority: 2
  surface: "PropertyItem"
  file: "src/components/PropertiesPanel/PropertyItem.tsx"
  instrumentation: "Fire in catch/onError of extract call. Include error reason if available."
```

**Do NOT include:** `Extract Type Dropdown Opened` (click, no outcome), `PropertyItem State Updated` (internal), `Attribute Input Focused` (too granular).
