---
name: compare-user-journeys
description: >
  Compares how two user groups behave differently by analyzing Amplitude Session Replays and metrics side by side. Produces a behavioral diff showing what one group does that the other doesn't. Use when a PM or growth lead asks "what do converters do differently", "how do power users behave", "why do churned users leave", "compare these cohorts", "what separates segment A from B", or wants to understand the qualitative behavioral gap between two user populations.
---

# Compare User Journeys

Investigate what distinguishes two user groups by pulling session replays and metrics for each, then producing a behavioral diff. This skill answers "what do winners do differently?" with concrete evidence from real sessions.

---

## CRITICAL: Tool Reference

**Primary tools:**

- **`Amplitude:get_amp_session_replay_info`** with `action: "search"` — Find sessions for each user group using event count filters and user property filters. Run this twice — once per group.
- **`Amplitude:get_amp_session_replay_info`** with `action: "events"` — Decode replays into interaction timelines. Run this for sessions from both groups.

**Supporting tools:**

- **`Amplitude:search_amp_entities`** — Search for existing charts, funnels, dashboards, and cohorts relevant to the comparison. Always check for existing analysis before building from scratch.
- **`Amplitude:use_amplitude_cohorts`** with `action: "list"` — Discover existing cohorts that define the groups (e.g., "power users", "churned", "converted").
- **Available taxonomy reader** — Inspect the connected catalog and use its
  event and property read capabilities to discover valid names and scopes.
- **`Amplitude:get_amplitude_charts`** with `include: "data"` — Pull quantitative metrics segmented by the two groups for statistical grounding.
- **`Amplitude:use_amplitude_ai_feedback`** with `facet: "insights"` / `facet: "mentions"` — Check if feedback themes differ between groups.

---

## Instructions

### Step 1: Define the Two Groups

Parse the user's request to identify Group A and Group B. Common comparison patterns:

| Comparison | Group A                      | Group B                    |
| ---------- | ---------------------------- | -------------------------- |
| Conversion | Users who completed the goal | Users who didn't           |
| Engagement | Power users / high-frequency | Casual / low-frequency     |
| Retention  | Retained users               | Churned users              |
| Plan tier  | Enterprise / paid            | Free / trial               |
| Outcome    | Successful (e.g., activated) | Failed (e.g., dropped off) |
| A/B test   | Variant A                    | Variant B                  |

For each group, determine:

- **Defining criteria**: What makes a user belong to this group? (cohort, event, property)
- **Labels**: Clear names for the report (e.g., "Converters" vs. "Drop-offs", not "Group A" vs "Group B")

If the user's request is ambiguous (e.g., "compare power users"), ask: "What defines a power user for your product — is there an existing cohort, or should I use a frequency/engagement threshold?"

### Step 2: Get Context and Discover Segments

1. Call `Amplitude:get_amplitude_context`. If multiple projects, ask which to compare within.
2. Call `Amplitude:use_amplitude_cohorts` with `action: "list"` to check if existing cohorts match the requested groups. Existing cohorts encode institutional knowledge — prefer them over ad-hoc definitions.
3. Use the available taxonomy event reader to discover events relevant to the comparison (the goal event for conversion comparisons, engagement events for activity comparisons, etc.).
4. Use the same catalog's property read capability for the key events to discover available segmentation properties and scopes.

### Step 3: Quantitative Comparison (Metrics)

Before watching replays, establish the statistical picture. Budget: 3-4 chart queries.

**First, search for existing analysis.** Call `Amplitude:search_amp_entities` with keywords related to the comparison (e.g., "onboarding funnel", "agent creation", "checkout conversion"). Existing charts and funnels encode institutional knowledge and save query budget. If you find a relevant funnel or segmented chart, use `Amplitude:get_amplitude_charts` with `include: "data"` on it instead of building from scratch.

Use `Amplitude:get_amplitude_charts` with `include: "data"` to compare the two groups on:

1. **Volume & composition**: How many users are in each group? What's the ratio?
2. **Key metrics segmented by group**: Conversion rates, session frequency, feature adoption, retention — whatever metrics are most relevant to the comparison.
3. **Feature usage differences**: Which events does Group A fire significantly more than Group B? Use event totals or unique user counts segmented by group.

**What to look for:**

- Large percentage differences in specific event frequencies
- Features used exclusively or predominantly by one group
- Timing differences (Group A does X on day 1, Group B waits until day 7)
- Volume differences (Group A does X 5 times per session, Group B does it once)

Record the top 3-5 quantitative differences — these become hypotheses to validate or enrich with replays.

### Step 4: Find Sessions for Both Groups

Run `Amplitude:get_amp_session_replay_info` with `action: "search"` **twice** — once for each group. Request `limit: 8` for each.

**Exclude internal users by default.** Unless you're specifically studying internal behavior, add a user property filter to exclude your company's email domain (e.g., `gp:email does not contain "amplitude.com"`). This prevents internal test sessions from polluting the comparison.

**Building group filters:**

If groups are defined by a **cohort**, filter on the cohort's defining user property or event.

If groups are defined by an **event outcome** (e.g., completed checkout vs. didn't):

- **Group A (converters)**: Filter for sessions containing the conversion event
  (use `events: [{"name": "<conversion event>", "minCount": 1}]`).
- **Group B (drop-offs)**: Filter for sessions containing the entry event but NOT the conversion event. Since `get_amp_session_replay_info` with `action: "search"` doesn't support "did not do" filters directly, filter for the entry event only, then when watching replays in Step 5, check the interaction timeline for absence of the conversion event. Discard sessions where the user actually converted and replace with additional sessions until you have 4-6 confirmed drop-offs.

If groups are defined by a **user property** (plan, segment):

- Use user property filters with `event_type: "_all"`.

### Step 5: Watch Sessions — Extract Interaction Timelines

For each group, call `Amplitude:get_amp_session_replay_info` with `action: "events"` for 4-6 sessions. Use `event_limit: 300`.

**Budget: 8-12 total sessions (4-6 per group).**

**Rate limiting and large responses:**

- Call `get_amp_session_replay_info` with `action: "events"` in batches of 3-4 at a time, not all at once. The Session Replay API enforces concurrency limits and will return 429 errors if overwhelmed. If you hit a 429, wait briefly and retry.
- Some sessions have extremely high interaction counts (100K+ raw events). If a response is too large and gets saved to a file, read the key portions from the saved file path. For sessions with very high `total_raw_events`, consider using a lower `event_limit` (e.g., 150) to stay within response size limits.

**While analyzing, track these behavioral dimensions for each session:**

| Dimension                 | What to capture                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| **Navigation path**       | Sequence of pages visited. Note the order and any pages unique to this session.            |
| **Feature engagement**    | Which features/areas the user interacted with. Note depth (quick glance vs. extended use). |
| **Pace & hesitation**     | Fast and confident vs. slow with pauses. Note long gaps between actions.                   |
| **Exploration vs. focus** | Did the user go straight to their goal or browse around?                                   |
| **Friction encountered**  | Errors, rage clicks, back-navigation, abandoned inputs.                                    |
| **Session outcome**       | Did they accomplish something? What was the last action before leaving?                    |

For each session, write a 2-3 sentence behavioral summary capturing the overall pattern.

### Step 6: Synthesize the Behavioral Diff

This is the core analytical step. Compare the two groups across the dimensions above.

1. **Tabulate patterns.** For each behavioral dimension, summarize what Group A typically does vs. Group B.

2. **Identify differentiating actions.** Find behaviors that are:
   - **Present in Group A, absent in Group B** — These are the strongest signals. "Converters explore the template gallery before creating their first project. Drop-offs skip it entirely."
   - **Present in both but with different frequency or depth** — "Both groups use search, but power users average 4 searches per session vs. 1 for casual users."
   - **Present in Group B, absent in Group A** — Negative signals. "Churned users spend time on the pricing page comparing plans. Retained users don't."

3. **Rank by explanatory power.** Which differences most plausibly explain the outcome gap? Lead with the most compelling.

4. **Generate hypotheses.** For each major difference, propose a causal hypothesis:
   - "Converters use templates because templates reduce time-to-value. If we surfaced templates more prominently, more users might convert."
   - "Churned users hit errors on the integration page. Fixing these errors could reduce churn."

5. **Cross-reference with feedback** (optional but valuable). Call `Amplitude:use_amplitude_ai_feedback` with `facet: "insights"` and terms related to the differentiating actions. If Group B complains about something Group A doesn't, that strengthens the signal.

### Step 7: Present the Behavioral Comparison

Structure the output as a comparative report a PM or growth lead can act on.

**Required sections:**

1. **Comparison Summary** (3-4 sentences): Who was compared, the sample size, the single most striking behavioral difference, and the top hypothesis. Written as a narrative you could paste into a strategy doc.

2. **Groups Defined**:
   - Group A: [Label] — definition, N sessions watched, N users in population
   - Group B: [Label] — definition, N sessions watched, N users in population
   - Time window analyzed

3. **Quantitative Context** — Key metric differences between groups (from Step 3). Present as a concise table:

```
| Metric | [Group A Label] | [Group B Label] | Delta |
|--------|-----------------|-----------------|-------|
| [Metric 1] | [value] | [value] | [diff] |
| [Metric 2] | [value] | [value] | [diff] |
```

4. **Behavioral Diff** — The core findings, ranked by explanatory power:

For each differentiating behavior:

```
### [Behavior Title — ≤10 words]
**Signal strength:** [Strong/Moderate/Emerging] | **Seen in:** X of Y [Group A] sessions vs. X of Y [Group B] sessions

**[Group A Label]:** What this group does — specific actions, pages, patterns observed.

**[Group B Label]:** What this group does instead — or doesn't do.

**Hypothesis:** Why this difference matters and what it suggests about the outcome gap.

**Evidence:** Replay links from both groups showing this contrast.
```

5. **Journey Maps** (optional, for flow comparisons): A simplified side-by-side view of the typical path each group takes:

```
[Group A]: Landing → Templates → Create Project → Invite Team → Active Use
[Group B]: Landing → Create Project → Settings → ... → Churn
```

6. **Actionable Hypotheses** (3-5 items): Concrete experiments or changes suggested by the behavioral differences. Each should follow the format: "If we [change], then [Group B behavior] should shift toward [Group A behavior], because [evidence]."

7. **Confidence & Caveats**: Note sample size limitations, whether patterns were consistent across sessions, and what additional data would increase confidence.

8. **Follow-on prompt**: Suggest next steps — "Want me to audit the [specific flow] where the groups diverge most, build a chart tracking [differentiating action], or investigate a specific user from either group?"

---

## Edge Cases

- **Groups are hard to distinguish.** If the two groups behave very similarly in replays, report that finding. It's valuable — it means the behavioral difference may be upstream (acquisition source, timing) rather than in-product. Suggest investigating pre-signup or external factors.
- **One group has few sessions.** If one group has <3 watchable sessions, note the limited sample and reduce confidence. Present findings as "preliminary" and suggest waiting for more data or broadening the time window.
- **User asks to compare 3+ groups.** Decline and suggest pairwise comparison: "Comparing more than 2 groups at once dilutes the analysis. Which two would you like me to start with?" Offer to run a second comparison after.
- **Cohort doesn't exist.** If the user references a segment that doesn't have a cohort, build the group filter from events and user properties. Suggest creating a cohort for reuse: "There's no 'power users' cohort defined. I'll filter by [criteria]. Want me to suggest a cohort definition to save?"
- **Conversion event isn't clear.** If comparing converters vs. non-converters but the conversion event isn't obvious, use the available taxonomy event reader and propose 2-3 candidate events. Let the user confirm.
- **nodeId limitations.** Interaction timelines show coordinates and node IDs, not element names. When comparing actions between groups, describe by page context and interaction sequence rather than specific UI elements. Focus on which pages and flows users engage with, not which buttons they click.

## Examples

### Example 1: Converter vs. Non-Converter

User says: "What do users who complete onboarding do differently from those who drop off?"

Actions:

1. Get context, discover onboarding events (signup, each onboarding step, activation event)
2. Query onboarding funnel conversion rate and identify the biggest drop-off step
3. Find sessions: Group A = completed activation event; Group B = started onboarding but didn't activate
4. Watch 4-5 sessions per group, track navigation paths and feature interactions
5. Synthesize: "Activators spend time on the template picker (avg 3 templates previewed). Drop-offs skip templates and go straight to blank project — then stall."
6. Present behavioral diff with hypothesis: "Templates reduce blank-page paralysis. Surfacing them earlier could lift activation."

### Example 2: Power Users vs. Casual Users

User says: "How do our most active users use the product differently?"

Actions:

1. Get context, check for existing "power user" cohort
2. Define groups: top 10% by session frequency vs. bottom 50%
3. Query feature usage segmented by group — which features show the biggest usage gap
4. Find sessions for both groups, extract timelines
5. Synthesize: "Power users use keyboard shortcuts and saved views. Casual users navigate through menus and re-do searches."
6. Present diff with hypothesis: "Discoverability of shortcuts and saved views is low. Adding onboarding tooltips could shift casual users toward power user patterns."

### Example 3: Retained vs. Churned

User says: "Why are some users churning after the first week?"

Actions:

1. Get context, define groups: users active in week 2+ vs. users who never returned after week 1
2. Query retention curve and week-1 engagement metrics by group
3. Find sessions from each group's first week
4. Compare: what did retained users do in week 1 that churned users didn't?
5. Cross-reference with feedback from churned users (if available)
6. Present: "Retained users connected an integration in their first session. Churned users didn't — and 3 of 5 churned users visited the integrations page but left without completing setup."
