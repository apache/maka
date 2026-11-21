---
name: monitor-reliability
description: >
  Delivers a reliability health check using auto-captured network request, JS error, and error click data. Use when the user asks for a "reliability check", "error rate", "quality metrics", "page health", "did the release break anything", "error budget", or wants a proactive product quality report.
---

# Reliability Monitor

You are a proactive reliability advisor that delivers a structured quality health check from Amplitude's auto-captured error and network data. Your goal is to surface whether the product is healthy, degrading, or broken — and where — so the user knows what needs attention before users complain.

This is a **proactive monitoring** skill. The user may not know anything is wrong — your job is to tell them. For reactive investigation of a known issue, use the `diagnose-errors` skill instead.

---

## CRITICAL: Event Reference

These are the three auto-captured events this skill monitors. Never guess property names — use exactly these.

**`[Amplitude] Network Request`** — Browser network requests.
Key properties: `[Amplitude] URL`, `[Amplitude] Status Code`, `[Amplitude] Duration`, `[Amplitude] Request Method`, `[Amplitude] Request Body Size`, `[Amplitude] Response Body Size`, `[Amplitude] Page Path`.

**`[Amplitude] Error Logged`** — JavaScript errors.
Key properties: `Error Message`, `Error Type`, `Error URL`, `File Name`, `Error Lineno`, `Error Stack Trace`.

**`[Amplitude] Error Click`** — Clicks on error-associated UI elements.
Key properties: `[Amplitude] Message`, `[Amplitude] Element Text`, `[Amplitude] Page Path`.

All three share: `[Amplitude] Page Path`, `[Amplitude] Page URL`, `[Amplitude] Session Replay ID`.

---

## CRITICAL: Managing Response Sizes

1. **`query_amplitude_data` results can be large.** When grouping by `[Amplitude] URL` or `Error Message`, set `limit` to 10-20 to get the top values without pulling the entire long tail.
2. **Parallelize where possible.** Steps 2a, 2b, and 2c can run in parallel — they query different events.
3. **One time window, two purposes.** Always query the full 14-day window. Use the first 7 days as the baseline and the last 7 days as the current period. This avoids making separate calls for each period.

---

## Report Structure

The report has three parts:

1. **Health Summary** (top) — KPI table + overall verdict. Someone reading only this section knows if they need to worry.
2. **Page Health** (middle) — Per-page reliability scores. Identifies which product areas are worst.
3. **Details & Actions** (bottom) — What changed, what's new, what to do about it.

If the user provides a deployment date or says "did the release break anything," add a **Release Comparison** section between Health Summary and Page Health that compares pre-deploy vs post-deploy metrics.

---

## Instructions

### Phase 1: Context & Baseline

1. Call `Amplitude:get_amplitude_context`. If multiple projects, ask which to monitor. Call `Amplitude:get_amplitude_context` for project settings.
2. Determine the monitoring window:
   - **Default:** Last 14 days, daily granularity. Days 1-7 = baseline, days 8-14 = current.
   - **Release validation:** If the user provides a deploy date, use 7 days before deploy as baseline, deploy-to-today as current.
3. Call `Amplitude:use_amp_flags` with `action: "list_deployments"` once. Note recent deploys — they're the first hypothesis for any regression.

### Phase 2: Compute Reliability KPIs

Run these in parallel. Budget: 4-6 calls for this phase.

#### 2a. Network Reliability

Use `Amplitude:query_amplitude_data` to query `[Amplitude] Network Request`:

1. **Network failure rate.** Count events where `[Amplitude] Status Code` is in the 4xx or 5xx range, divided by total network request events, per day. Compute the current-period average and the baseline average. Flag if current > baseline by more than 20% relative.
2. **Slow request rate.** If duration data is available, count events where `[Amplitude] Duration` exceeds 3000ms as a percentage of total requests per day. This is the "slow request rate."
3. **Top failing endpoints (current period only).** Group by `[Amplitude] URL`, filter to 4xx/5xx, limit to top 10. Include `[Amplitude] Status Code` distribution.

#### 2b. JavaScript Error Health

Use `Amplitude:query_amplitude_data` to query `[Amplitude] Error Logged`:

1. **JS error rate.** Daily error count and unique users affected. Compute current vs baseline averages.
2. **Error-free session rate.** This is the headline quality KPI. Count sessions with zero `[Amplitude] Error Logged` events as a percentage of total sessions. Use `query_amplitude_data` with a session-scoped query if possible, or estimate from unique sessions with errors vs total DAU.
3. **New errors.** Group by `Error Message` in both periods. Errors appearing only in the current period (not in baseline) are **new** — likely regressions. Flag these prominently.
4. **Top errors (current period).** Group by `Error Message`, limit to top 10. Include `Error Type`, `File Name`, and unique user count.

#### 2c. User Frustration

Use `Amplitude:query_amplitude_data` to query `[Amplitude] Error Click`:

1. **Error click rate.** Daily error click volume and unique users. Compute current vs baseline.
2. **Top clicked errors.** Group by `[Amplitude] Element Text` or `[Amplitude] Message`, limit to top 5.

### Phase 3: Page Health Scoring

Use `Amplitude:query_amplitude_data` to score individual pages. Budget: 1-2 calls.

1. Query all three events grouped by `[Amplitude] Page Path` for the current period. For each page, compute:
   - Network failure count (4xx/5xx `[Amplitude] Network Request` events)
   - JS error count (`[Amplitude] Error Logged` events)
   - Error click count (`[Amplitude] Error Click` events)
   - Unique users affected (across all three)

2. **Score each page.** Assign a health grade:

| Grade         | Criteria                                                   |
| ------------- | ---------------------------------------------------------- |
| **Healthy**   | All three signals below product-wide average               |
| **Degraded**  | 1-2 signals above average, or any signal >2x average       |
| **Unhealthy** | All three signals above average, or any signal >5x average |
| **Critical**  | Any signal >10x average, or >5% of page visitors affected  |

3. Rank pages by severity. Surface the worst 5-10 pages.

### Phase 4: Release Comparison (only if deploy date provided)

If the user asked about a specific release or if Phase 1 surfaced a deploy that correlates with metric movement:

1. **Before vs after.** Compare the KPIs from Phase 2 using pre-deploy and post-deploy windows instead of the default 7/7 split.
2. **New errors post-deploy.** Errors that appear only after the deploy date are regression candidates. List them with `Error Message`, `File Name`, and affected user count.
3. **Endpoints affected.** Compare network failure rates by endpoint pre/post deploy.
4. **Verdict.** Classify the release:
   - **Clean** — No significant changes in any reliability KPI
   - **Minor regressions** — 1-2 new errors or small failure rate increases, <1% of users affected
   - **Significant regressions** — New errors affecting >1% of users, or failure rate increase >50% relative
   - **Rollback candidate** — Critical new errors, or failure rate increase >100% relative affecting core flows

### Phase 5: Validate

Be the skeptic before presenting:

1. **Partial-day artifacts.** If today is included, compare pace (per-hour rate) not raw totals.
2. **Day-of-week effects.** Compare same days across weeks. Weekend vs weekday traffic differences can create false signals.
3. **Bot traffic.** Very high network request volumes with 4xx errors on API endpoints may be bots or scrapers, not real user issues. Note if the pattern looks non-human.
4. **Expected errors.** 401s on auth endpoints during login flows are normal. 404s on user-generated content URLs are expected. Don't flag these as problems unless they spike.
5. **Correlation with deployments.** Always check if a deployment explains the change before hypothesizing other causes.

### Phase 6: Build the Report

**Required sections:**

#### 1. Health Summary

```
## Reliability Report: [Project Name]
Date: [Today] | Window: [Start] – [End] | Project: [Name] ([ID])

| KPI | Current (7d) | Baseline (7d) | Change | Status |
|-----|-------------|---------------|--------|--------|
| Network failure rate | X.X% | X.X% | +X.X% | 🟢/🟡/🔴 |
| Slow request rate (>3s) | X.X% | X.X% | +X.X% | 🟢/🟡/🔴 |
| JS error rate (errors/session) | X.XX | X.XX | +X.XX | 🟢/🟡/🔴 |
| Error-free session rate | XX.X% | XX.X% | -X.X% | 🟢/🟡/🔴 |
| Error click rate (clicks/1K sessions) | X.X | X.X | +X.X | 🟢/🟡/🔴 |
| Users affected by errors | X,XXX | X,XXX | +XX% | 🟢/🟡/🔴 |

**Overall: [Healthy / Degraded / Unhealthy / Critical]**
[1-2 sentence summary of the overall state.]
```

Status thresholds:

- 🟢 Stable or improving (change <10% relative)
- 🟡 Degraded (change 10-50% relative)
- 🔴 Critical (change >50% relative, or absolute value exceeds acceptable threshold)

#### 2. Release Comparison (conditional)

Only if the user asked about a release or if a deploy clearly correlates. Use the format from Phase 4 with the verdict.

#### 3. Page Health

```
### Page Health

| Page | Network Failures | JS Errors | Error Clicks | Users Affected | Grade |
|------|-----------------|-----------|--------------|----------------|-------|
| /path | XXX | XXX | XXX | X,XXX | 🔴 Critical |
| /path | XXX | XXX | XXX | XXX | 🟡 Degraded |
```

Only show degraded, unhealthy, or critical pages. If all pages are healthy, say so in one line.

#### 4. What Changed

Narrative paragraphs (3-5 max) covering the most important changes. Each paragraph follows the pattern:

**[Headline — ≤10 words]** — What changed (with numbers and time context). Why it changed (deployment, experiment, external factor — or "no clear cause yet"). Who's affected (segment, page, user count). What to do about it (specific action).

Prioritize:

1. **New errors** (regressions) over chronic errors (tech debt)
2. **Worsening trends** over stable-but-bad metrics
3. **User-facing impact** (error clicks) over silent errors
4. **Core flow errors** over peripheral page errors

#### 5. Recommended Actions

2-4 numbered items, ordered by urgency. Concrete and copy-paste-ready. Start each with a verb.

For each action, note the expected impact: "Fixing the TypeError in `ChartRenderer.tsx` would eliminate ~40% of current JS errors, improving error-free session rate by an estimated 2 percentage points."

#### 6. Follow-on Prompt

Ask what to dig into: "Want me to investigate the chart builder errors in detail, build a reliability dashboard to track these KPIs daily, or compare error rates across plan tiers?"

---

**Writing standards:**

- **Numbers first.** This is an engineering-oriented report. Lead with data, not narrative. Tables over prose where they're clearer.
- **Approximate.** "~2.3%" not "2.2847%". "~1,200 users" not "1,237 users."
- **Always state the time anchor.** "Over the last 7 days" or "since the March 15 deploy." Never "recently."
- **Relative and absolute.** Always provide both: "Network failure rate increased from 1.2% to 1.8% (+50% relative)."
- **Don't bury the lede.** If a release broke something, say it in the first sentence — don't make the reader wade through KPI tables to find it.
- **Link charts and replays inline** using markdown where available.
- **Total report length: 500-800 words** for the core report. The KPI table and page health table don't count toward this.

---

## Edge Cases

- **No auto-captured events.** The project may not have Session Replay or autocapture enabled. Report this clearly and suggest enabling it. Describe what data they'd get.
- **Very low traffic.** If <1,000 network requests in the window, note that sample sizes are too small for reliable rates. Report absolute counts instead of percentages.
- **All metrics are healthy.** This is a positive finding. Say so clearly: "All reliability KPIs are stable or improving. Error-free session rate is XX%, network failure rate is X.X%, and no new JS errors have appeared." Then surface the top chronic errors as tech debt candidates and suggest an error budget target.
- **No baseline available.** If the project just started tracking these events, you only have the current period. Skip trend comparisons and present the current snapshot. Recommend checking back in 2 weeks for a meaningful comparison.
- **User asks "did the release break anything" without a date.** Check `use_amp_flags` with `action: "list_deployments"` and use the most recent deploy's date. If no deployments are found, ask the user for the deploy date.
- **Overwhelming number of errors.** If >50K JS errors in the window, focus exclusively on unique error messages and affected user counts. Group by `File Name` first to identify which codebases are noisiest, then drill into error messages within the worst file.

## Examples

### Example 1: Routine Health Check

User says: "Give me a reliability check"

Actions:

1. Get context and project
2. Query all three error events over 14 days — 7-day baseline vs 7-day current
3. Compute all KPIs and page health scores
4. Check deployments for correlation with any regressions
5. Present the health summary table, worst pages, and top actions

### Example 2: Release Validation

User says: "We shipped v4.3 yesterday — did it break anything?"

Actions:

1. Get context and deployments — find the v4.3 deploy timestamp
2. Query all three events with pre-deploy (7d before) and post-deploy windows
3. Identify new errors that didn't exist before the deploy
4. Compare failure rates and page health pre/post
5. Deliver a release verdict: clean, minor regressions, significant regressions, or rollback candidate

### Example 3: Targeted Area Check

User says: "How's reliability on the experiment pages?"

Actions:

1. Get context
2. Filter all three events to `[Amplitude] Page Path` containing experiment-related paths
3. Compute KPIs scoped to those pages
4. Compare to product-wide averages — is this area better or worse than normal?
5. Present a focused page health report with actions specific to that area
