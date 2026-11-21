---
name: diagnose-errors
description: >
  Investigates errors across network failures, JavaScript errors, and error clicks to identify what's broken, where, and why. Use when the user says "what's broken", "errors are up", "why are users seeing errors", "JS errors", "network failures", "5xx spike", "something is broken", or wants to triage product reliability issues.
---

# Error Diagnosis & Triage

Investigate product errors by triaging across three auto-captured event types — `[Amplitude] Network Request`, `[Amplitude] Error Logged`, and `[Amplitude] Error Click` — to identify what's broken, which users are affected, and what's causing it. This skill cross-references all three signals to surface causal chains (failed request → JS error → user frustration) rather than treating each in isolation.

This is a **reactive investigation** skill — the user has a signal (spike, complaint, experiment regression, gut feeling) and wants to understand what's happening. For proactive monitoring, use the `monitor-reliability` skill instead.

---

## CRITICAL: Event Reference

These are the three auto-captured events this skill operates on. Never guess property names — use exactly these.

**`[Amplitude] Network Request`** — Browser network requests.
Key properties: `[Amplitude] URL`, `[Amplitude] Status Code`, `[Amplitude] Duration`, `[Amplitude] Request Method`, `[Amplitude] Request Type`, `[Amplitude] Request Body Size`, `[Amplitude] Response Body Size`, `[Amplitude] Start Time`, `[Amplitude] Completion Time`, `[Amplitude] Page Path`.

**`[Amplitude] Error Logged`** — JavaScript errors.
Key properties: `Error Message`, `Error Type`, `Error URL`, `File Name`, `Error Lineno`, `Error Colno`, `Error Stack Trace`, `[Amplitude] Error Detection Source`.

**`[Amplitude] Error Click`** — Clicks on error-associated UI elements.
Key properties: `[Amplitude] Message`, `[Amplitude] Kind`, `[Amplitude] Filename`, `[Amplitude] Line Number`, `[Amplitude] Column Number`, `[Amplitude] Element Text`, `[Amplitude] Element Tag`, `[Amplitude] Element Hierarchy`.

All three share: `[Amplitude] Page Path`, `[Amplitude] Page URL`, `[Amplitude] Session Replay ID`.

---

## Instructions

### Step 1: Context & Scope

1. Call `Amplitude:get_amplitude_context`. If multiple projects, ask which to investigate.
2. Determine the investigation scope from the user's request:
   - **Broad triage**: "What's broken?" → scan all three event types for the biggest problems
   - **Targeted**: "Network errors are up" → start with `[Amplitude] Network Request`, then check if they cascade into JS errors
   - **Specific error**: "Users are seeing TypeError" → start with `[Amplitude] Error Logged`, filtered to that error
3. Determine the time window. Default to the last 7 days with daily granularity unless the user specifies otherwise. If they mention a deploy or date, anchor to that.

### Step 2: Quantify the Error Landscape

Run these in parallel where possible. Budget: 4-6 calls for this step.

#### 2a. Network Failures

Use `Amplitude:query_amplitude_data` to query `[Amplitude] Network Request`:

1. **Failure rate trend.** Filter `[Amplitude] Status Code` to 4xx and 5xx ranges. Measure daily event counts and unique users. Compare to total network request volume for a failure rate percentage.
2. **Top failing endpoints.** Group by `[Amplitude] URL` to rank which APIs fail most. Include `[Amplitude] Status Code` as a secondary grouping to distinguish 401s (auth) from 500s (server errors) from 404s (missing).
3. **Slow endpoints (if relevant).** If the user mentions performance or slowness, measure `[Amplitude] Duration` by `[Amplitude] URL`. Flag P95 > 3s or mean > 1s.

#### 2b. JavaScript Errors

Use `Amplitude:query_amplitude_data` to query `[Amplitude] Error Logged`:

1. **Error volume trend.** Daily error count and unique users affected over the time window. Flag day-over-day spikes >25%.
2. **Top errors.** Group by `Error Message` to find the highest-volume errors. Include `Error Type` and `File Name` for context.
3. **New vs. chronic.** Compare errors in the recent window to the prior period. Errors that appear only in the recent window are likely regressions. Errors present in both are chronic tech debt.

#### 2c. Error Clicks (Frustration Signal)

Use `Amplitude:query_amplitude_data` to query `[Amplitude] Error Click`:

1. **Volume trend.** Daily error click count. Spikes indicate users are actively encountering and engaging with error states.
2. **What users are clicking.** Group by `[Amplitude] Element Text` or `[Amplitude] Message` to see which error UI elements get the most interaction.

### Step 3: Cross-Event Correlation

This is where the skill adds value beyond looking at each event in isolation.

1. **Failed request → JS error chain.** Compare the timing and pages of network failures (Step 2a) with JS errors (Step 2b). If the same pages have both 5xx network failures AND JS errors, the network failure is likely the root cause. Use `[Amplitude] Page Path` as the join dimension.

2. **Error → frustration chain.** Compare JS error pages with error click pages. High error click volume on pages with high JS error rates confirms users are seeing and interacting with the broken experience.

3. **Page-level triage.** Use `Amplitude:query_amplitude_data` to group all three events by `[Amplitude] Page Path`. Produce a page-level error heatmap:
   - Pages with network failures + JS errors + error clicks = **critical** (full causal chain)
   - Pages with JS errors + error clicks but no network failures = **frontend bug**
   - Pages with network failures but no JS errors = **backend issue, gracefully handled**
   - Pages with JS errors but no error clicks = **silent errors** (may not affect UX)

### Step 4: Identify Affected Users & Segments

For the top 2-3 error patterns from Step 3:

1. **User scope.** Use `Amplitude:query_amplitude_data` to count unique users affected. Compare to total active users for an impact percentage.
2. **Segment breakdown.** Group by available user properties (platform,
   browser, country, plan tier, org) to determine if errors concentrate in a
   specific segment. If discovery is needed, inspect the connected catalog and
   use its current taxonomy property reader.
3. **Session Replays.** For the most impactful error pattern, call `Amplitude:get_amp_session_replay_info` with `action: "search"` filtered to sessions containing the error event. Provide 2-3 replay links so the user can see exactly what happened.

### Step 5: Root Cause Hypothesis

Build a root cause hypothesis using evidence from the prior steps:

1. **Deployment correlation.** Call `Amplitude:use_amp_flags` with `action: "list_deployments"` once. Check if error spikes align with recent deploys. If a deployment shipped within 24 hours of the error spike, it's the leading hypothesis.
2. **Experiment correlation.** If the user mentions an experiment or if errors concentrate in a segment that maps to an experiment variant, call `Amplitude:use_amp_experiments` with `action: "get"`, then with `action: "analyze"` to check.
3. **Temporal pattern.** Is the error constant, intermittent, or growing? Constant suggests a code bug. Intermittent suggests infrastructure. Growing suggests a progressive failure (memory leak, queue backlog).
4. **Feedback correlation.** Call `Amplitude:use_amplitude_ai_feedback` with `facet: "sources"` then `facet: "insights"` with keywords from the top error messages. If users are reporting the same issue, it validates the impact and may provide additional context the data can't.

### Step 6: Present the Diagnosis

Structure the output as a triage report. Lead with what's most broken and actionable.

**Required sections:**

1. **Diagnosis summary** (2-3 sentences): The single most important finding. Written as a headline you'd send to the engineering lead. Include scope: how many users, which pages, since when.

2. **Error landscape** — A table summarizing the state across all three signal types:

```
| Signal | Volume (7d) | Trend | Top Source | Severity |
|--------|-------------|-------|------------|----------|
| Network failures (4xx/5xx) | [N] requests | [↑/↓/→] | [endpoint] | [Critical/High/Medium/Low] |
| JS errors | [N] errors, [N] users | [↑/↓/→] | [Error Message] | ... |
| Error clicks | [N] clicks | [↑/↓/→] | [Element Text] | ... |
```

3. **Top errors** (3-5 max): Each as a narrative paragraph:
   - **[Error headline — ≤10 words]** — What's happening (the error), where (page/endpoint), who's affected (user count/segment), since when (deployment or date), and what to do (specific fix action). Include chart links and replay links inline.

4. **Causal chains** (if found): Describe the cross-event chain. "POST to `/api/query` is returning 500 → this triggers an unhandled TypeError in `ChartRenderer.tsx:142` → users see and click the error state. ~1,200 users affected in the last 7 days."

5. **Recommended actions** (2-4 numbered items): Concrete, copy-paste-ready. Start each with a verb. Bias toward fixing, investigating further with a specific breakdown, or setting up monitoring.

6. **Follow-on prompt**: Ask what to dig into next — e.g., "Want me to segment the API failures by org tier, watch a few session replays, or build a monitoring dashboard for these errors?"

**Severity classification:**

| Severity     | Criteria                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------- |
| **Critical** | >5% of users affected, full causal chain (network → error → frustration), or blocking a core flow |
| **High**     | 1-5% of users, JS errors on key pages, or a clear regression from a deploy                        |
| **Medium**   | <1% of users, chronic errors, or errors on non-critical pages                                     |
| **Low**      | Silent errors with no user-facing impact, or errors isolated to a single edge-case segment        |

---

## Edge Cases

- **No auto-captured error events.** The project may not have Session Replay or autocapture enabled. Report this clearly: "This project doesn't appear to have `[Amplitude] Network Request`, `[Amplitude] Error Logged`, or `[Amplitude] Error Click` events. These require Session Replay or the autocapture plugin to be enabled." Suggest the user check their SDK configuration.
- **Very high error volume.** If >100K errors in the window, focus on unique error messages and affected user counts, not raw event counts. Group aggressively.
- **All errors are chronic.** If nothing is new, frame findings as tech debt priorities rather than regressions. Compare error-free session rate to establish a baseline.
- **Error data is sparse.** If only one of the three events has data, work with what's available. Note which signals are missing and what they would add.
- **User asks about a specific error message.** Skip the broad landscape scan (Step 2) and go directly to filtering `[Amplitude] Error Logged` by `Error Message`. Then check for correlated network failures and error clicks.
- **User asks about a specific user or org.** Scope all queries to that user/org. Provide a session-level timeline of errors rather than aggregate trends. Prioritize Session Replay links.

## Examples

### Example 1: Broad Error Triage

User says: "What's broken right now?"

Actions:

1. Get context and project
2. Query all three error events for the last 7 days — volume, trend, top sources
3. Cross-reference by page to find causal chains
4. Check deployments for correlation
5. Surface the 3-5 biggest issues ranked by user impact
6. Provide replay links for the worst pattern

### Example 2: Regression Investigation

User says: "Errors seem up since yesterday's deploy"

Actions:

1. Get context and check `use_amp_flags` with `action: "list_deployments"` for what shipped
2. Query `[Amplitude] Error Logged` comparing pre-deploy (7d before) vs post-deploy (last 24h)
3. Identify new error messages that didn't exist before the deploy
4. Check if new errors correlate with failing network requests
5. Segment by page and feature to isolate the blast radius
6. Present findings anchored to the specific deployment

### Example 3: Specific Error Deep-Dive

User says: "We're seeing a lot of TypeErrors in the chart builder"

Actions:

1. Filter `[Amplitude] Error Logged` to `Error Type = TypeError` and `[Amplitude] Page Path` containing the chart builder
2. Group by `Error Message` and `File Name` to find the specific errors
3. Check `[Amplitude] Network Request` on the same pages for failing API calls
4. Pull session replays of users who hit the TypeError
5. Present the error with reproduction steps derived from replay patterns
