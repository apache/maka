---
name: replay-ux-audit
description: >
  Finds and analyzes Amplitude Session Replays to surface UX friction patterns across multiple sessions. Produces a ranked friction map showing where users struggle, hesitate, or abandon. Use when a PM or designer asks "where's the friction", "what's confusing users", "UX issues on this page", "why is this flow clunky", "audit the user experience", or wants qualitative evidence of usability problems in a specific feature or flow.
---

# Replay UX Audit

Watch 5-10 session replays for a specific feature, page, or flow, then synthesize patterns into a ranked friction map. This skill turns hours of manual replay watching into a structured UX report grounded in real user behavior.

---

## CRITICAL: Tool Reference

**Primary tools:**

- **`Amplitude:get_amp_session_replay_info`** with `action: "search"` — Find sessions matching event filters, user properties, or time windows. Use this to target sessions for a specific feature or flow.
- **`Amplitude:get_amp_session_replay_info`** with `action: "events"` — Decode a replay into an interaction timeline: navigations, clicks, inputs, scrolls. This is what you "watch."

**Supporting tools:**

- **Available taxonomy reader** — Inspect the connected catalog and use its
  event and property read capabilities to discover valid filter names and
  scopes. Never guess them.
- **`Amplitude:get_amplitude_charts`** with `include: "data"` — Pull quantitative context (funnel conversion rates, feature adoption) to anchor the qualitative replay findings.
- **`Amplitude:use_amplitude_ai_feedback`** with `facet: "insights"` / `facet: "mentions"` — Cross-reference replay friction with customer feedback themes.

---

## Instructions

### Step 1: Define the Audit Scope

Determine what to audit from the user's request:

- **Page or URL pattern**: A specific page (e.g., /settings, /checkout)
- **Feature or flow**: A multi-step process (e.g., onboarding, report creation)
- **Event-based**: Sessions containing a specific event (e.g., "Export Clicked")
- **Broad**: "Audit the whole product" — narrow this down. Ask: "Which area would you like me to start with?" Suggest 2-3 areas based on high-traffic pages or known problem areas if you can identify them.

Also determine:

- **Time window**: Default to last 14 days unless specified.
- **User segment** (optional): Specific plan, platform, cohort, or user type.

### Step 2: Get Context and Discover Events

1. Call `Amplitude:get_amplitude_context`. If multiple projects, ask which to audit.
2. Use the available taxonomy event reader to find events related to the target area. Look for:
   - Page view or navigation events for the target area
   - Key interaction events (clicks, form submissions) within the flow
   - Error or failure events that may indicate friction
3. If the user mentioned a flow or funnel, identify the key step events so you can filter sessions that attempted the flow.

### Step 3: Gather Quantitative Baseline (Optional but Recommended)

Before watching replays, establish context with 1-2 chart queries. Budget: 2 calls max.

- If auditing a **funnel**: Use `Amplitude:get_amplitude_charts` with `include: "data"` to get the current conversion rate and identify the worst drop-off step. This tells you where to focus your replay attention.
- If auditing a **page**: Query the page's traffic volume and any error rates to understand scale.
- If auditing a **feature**: Query adoption/usage frequency to understand how many users interact with it.

This quantitative baseline makes your qualitative findings more actionable — "40% of users drop off at step 3, and here's what we see them doing" is stronger than "users seem confused at step 3."

### Step 4: Find Target Sessions

Use `Amplitude:get_amp_session_replay_info` with `action: "search"` to find 8-12 sessions (request `limit: 12` to allow for some sessions with missing replay data).

**Filter strategy by audit type:**

- **Page audit**: Filter by event on that page (use page path property if available).
- **Flow audit**: Filter by the entry event of the flow. Optionally add a second filter for sessions that did NOT complete the flow (to focus on drop-offs).
- **Feature audit**: Filter by the feature's key interaction event.
- **Segment comparison**: Run two searches — one for each segment — to compare behavior.

If the user specified a segment (plan type, platform, etc.), add user property filters.

### Step 5: Watch Sessions — Extract Interaction Timelines

For each session, call `Amplitude:get_amp_session_replay_info` with `action: "events"` and `event_limit: 300`.

**Budget: 5-8 sessions.** Skip sessions that return empty or minimal data.

**While analyzing each session, track these friction signals:**

| Signal                  | What to look for in the timeline                                                       |
| ----------------------- | -------------------------------------------------------------------------------------- |
| **Rage clicks**         | 3+ clicks on the same coordinates within a short time span                             |
| **Hesitation**          | Long pauses (>10 seconds) between navigation and first interaction on a page           |
| **Back-and-forth**      | Navigating to a page, then back, then forward again                                    |
| **Abandoned inputs**    | Starting to type in a field, then navigating away without submitting                   |
| **Excessive scrolling** | Large scroll deltas suggesting the user is searching for something                     |
| **Dead-end navigation** | Visiting a page and immediately leaving (bounce within seconds)                        |
| **Repeat attempts**     | Performing the same action multiple times (re-submitting a form, re-clicking a button) |

For each session, write a brief summary:

- Pages visited in the target area
- Key actions taken
- Friction signals observed (with timestamps)
- Whether the user completed their apparent goal

### Step 6: Synthesize Friction Patterns

This is the core analytical step. Aggregate findings across all watched sessions.

1. **Group friction signals by location.** Cluster observations by the page or step where they occurred.
2. **Count frequency.** How many of the watched sessions showed this friction? Express as "seen in X of Y sessions."
3. **Assess severity.** Use this rubric:

| Severity     | Criteria                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| **Critical** | Blocks task completion. User gives up or encounters an error. Seen in 50%+ of sessions.                              |
| **High**     | Causes significant confusion or delay. User eventually succeeds but with visible struggle. Seen in 30%+ of sessions. |
| **Medium**   | Causes minor hesitation or suboptimal paths. User recovers quickly. Seen in 20%+ of sessions.                        |
| **Low**      | Cosmetic or minor annoyance. Seen in <20% of sessions or only in edge cases.                                         |

4. **Identify root cause hypotheses.** For each friction pattern, hypothesize why it happens:
   - Unclear UI labeling or hierarchy
   - Missing feedback after an action (loading state, confirmation)
   - Unexpected behavior (click does nothing, page doesn't respond)
   - Information not where users expect it (excessive scrolling/searching)
   - Error state without clear recovery path
   - Too many steps or cognitive load

5. **Cross-reference with feedback** (if available). Call `Amplitude:use_amplitude_ai_feedback` with `facet: "insights"` and keywords from your friction findings. If users are complaining about the same thing you're seeing in replays, that's high-confidence signal.

### Step 7: Present the UX Audit

Structure the output as a friction map that a PM or designer can act on.

**Required sections:**

1. **Audit Summary** (3-4 sentences): What was audited, how many sessions were watched, the single biggest finding, and overall UX health assessment. Written as a narrative you could paste into a design review doc.

2. **Scope & Methodology**:
   - Feature/flow/page audited
   - Time window
   - Sessions analyzed: N (with replay links)
   - User segment (if filtered)
   - Quantitative baseline (if gathered in Step 3)

3. **Friction Map** — Ranked by severity, then frequency:

For each friction point:

```
### [Friction Point Title — action-oriented, ≤10 words]
**Severity:** [Critical/High/Medium/Low] | **Frequency:** Seen in X of Y sessions

**What happens:** Describe the user behavior observed — what they do, where they
hesitate, what goes wrong. Be specific about the page and interaction.

**Likely cause:** Your hypothesis for why this friction exists.

**Evidence:**
- Session replay links showing this pattern
- Quantitative data (if available): conversion rate at this step, error rate, etc.
- Customer feedback quotes (if found)

**Suggested fix:** One concrete, actionable recommendation.
```

4. **Positive Patterns** (1-2 items): What's working well. Which parts of the experience were smooth across sessions. This provides balance and highlights what to preserve.

5. **Recommended Next Steps** (3-5 numbered items): Start each with a verb. Prioritize by impact. Examples:
   - "Redesign the [specific element] to make [action] more discoverable"
   - "Add a loading indicator after [action] to reduce rage clicks"
   - "Run an A/B test on [proposed change] to validate the hypothesis"
   - "Instrument [specific interaction] to track this friction quantitatively"
   - "Watch 5 more sessions filtered to [specific segment] to confirm if this is segment-specific"

---

## Edge Cases

- **No sessions found for the target area.** The feature may have low traffic or events may not be instrumented for that page. Report this and suggest: "Consider adding event tracking to [area] so session replays can be filtered to it."
- **Sessions are too short.** If most sessions are <30 seconds with minimal interactions, the page may have a bounce problem rather than a friction problem. Report this as a finding and suggest investigating why users leave so quickly.
- **All sessions look smooth.** This is a valid finding. Report that the UX appears healthy based on N sessions. Suggest looking at a different area or a specific user segment that may have different behavior.
- **Replay events are sparse.** Some sessions may have limited interaction data (ad blockers, slow connections). Skip these and note how many were skipped. If most sessions are sparse, note it as a data quality issue.
- **User asks to audit "everything."** Decline politely. Suggest starting with the highest-traffic flow or the area with the worst funnel conversion. Offer to audit additional areas after the first one.
- **nodeId limitations.** Interaction timelines show coordinates and node IDs, not element names. Describe actions by page context and position: "clicks in the header area," "interacts with the form's third field." Avoid asserting specific element identity unless clearly inferable from the page URL and action sequence.

## Examples

### Example 1: Flow Audit

User says: "Audit the onboarding experience for new users"

Actions:

1. Get context, discover onboarding-related events
2. Query the onboarding funnel for conversion rates and worst drop-off step
3. Find 8-10 sessions of new users going through onboarding
4. Extract timelines, track friction signals at each step
5. Synthesize: "4 of 7 users hesitated for 15+ seconds on the workspace setup step. 3 users navigated back to re-read instructions."
6. Present friction map ranked by severity with replay links

### Example 2: Page Audit

User says: "What's the UX like on our pricing page?"

Actions:

1. Get context, find pricing page events (page view, plan selection, CTA clicks)
2. Query pricing page traffic and click-through rate as baseline
3. Find 8 sessions that visited the pricing page
4. Extract timelines, focus on: how far users scroll, what they click, whether they compare plans, how long they stay
5. Synthesize patterns: excessive scrolling (plan comparison is below fold), hesitation on CTA (unclear pricing)
6. Present friction map with specific redesign suggestions

### Example 3: Feature Audit with Segment

User says: "Are enterprise users having trouble with the report builder?"

Actions:

1. Get context, find report builder events
2. Filter sessions to enterprise plan users + report builder events
3. Extract timelines from 6-8 sessions
4. Focus on: completion rate of report creation, where users get stuck, any error patterns
5. Cross-reference with feedback filtered to "report" keywords
6. Present findings specific to enterprise segment, noting if this differs from general population
