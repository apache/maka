---
name: analyze-dashboard
description: Deeply analyze Amplitude dashboards by analyzing key charts, surfacing top areas for concern and takeaways, identify anomalies, then explain changes using customer feedback trends
---

# Analyze Dashboard

## When to Use

- Meeting prep: Synthesize a dashboard into talking points before a review or exec meeting
- Cross-chart pattern detection: Spot correlations across multiple charts that are hard to see manually
- Dashboard investigation: A key number moved in a chart within this dashboard and you want to explain why
- Connecting quant to qual: Understand if user feedback explains the trends you're seeing
- Onboarding to unfamiliar dashboards: Get up to speed on what a dashboard tracks and its current state

## Instructions

### Step 0: Identify the Dashboard ID

If the user gives a URL, use `Amplitude:get_from_url` to get the dashboard ID

### Step 1: Retrieve the Dashboard

Use `Amplitude:use_amp_dashboards` with `action: "get"` and the dashboard ID to get the full structure and chart IDs.

### Step 2: Query All Charts

Use `Amplitude:get_amplitude_charts` with `include: "data"` to fetch data for up to 3 charts at a time. Prioritize:

1. Primary KPI charts (usually at the top)
2. Charts with recent changes
3. Trend-based visualizations

### Step 3: Analyze Patterns

When analyzing charts, focus on the most decision-relevant signals for each type:

- KPI tiles: Context (timeframe, user type) and % change if shown.
- Line / Time series: Trends, slope changes, or notable events (not right-edge noise).
- Funnel: Major drop-off steps or unexpected retention. Use conversion framing (solid bars), not dropoff framing, unless explicitly relevant.
- Bar / Categorical: Concentrations, gaps, or surprising distributions.
- Stacked area: Total volume shifts and changing composition over time.
- Retention by interval: Compare segments at key intervals (Day 1, Day 7, Day 30).
- Retention over time: Recent cohorts may show incomplete periods (dotted lines) because they haven't completed the retention window yet—this does NOT mean retention is declining.
- Tables: Top contributors, dominant players, distribution imbalances.

### Step 4: Contextualize with User Feedback (Optional)

If significant changes or anomalies are detected, check if user feedback can explain them:

1. Use `Amplitude:use_amplitude_ai_feedback` with `facet: "insights"` and:
   - The same `projectId` as the dashboard
   - `dateStart` and `dateEnd` matching the analysis period
   - Filter by relevant types: `request`, `complaint`, `lovedFeature`, `bug`, `painPoint`

2. Look for feedback themes that correlate with metric changes:
   - Feature complaints aligning with engagement drops
   - Bug reports coinciding with conversion dips
   - Loved features matching usage increases

3. If a relevant insight is found, use `Amplitude:use_amplitude_ai_feedback` with `facet: "mentions"` and the `insightId` to pull specific user quotes that illustrate the pattern.

**Skip this step if:**

- No feedback sources are configured for the project
- No insights match the time period or observed changes
- The dashboard changes are minor or expected

### Step 5: Synthesize Findings

Present a structured summary:

1. **Overall Health**: Concise, actionable, and easily understandable one-liner of THE top takeaway or set of key takeaways from the dashboard analysis.
2. **Areas of Concern 🚩**: Top 1-3 urgent issues worth investigating or negative metric trends. If no issues are urgent, it's great to concisely acknolwedge there's no urgent areas of concern so that the reader has less noise to sift through.
3. **Key Takeaways 💡**: Top 1-3 most important or surprising insights from the analysis not included in the areas of concern.
4. **Recommendations**: Very concise section recapping up to the top 3 specific actionable recommendations (unless prompted otherwise) to follow-up on. Include [p0],[p1],[p2],[p3] in front of each title to help size priority with p0 being most urgent and p3 being least.

## Best Practices

- Be comprehensive in your investigation and analysis but concise, actionable, and metric-backed in your response.
- Do not repeat the same takeaway multiple times across sections.
- Always link referenced charts using markdown (e.g., `[DAU](https://app.amplitude.com/...)`). In terminal mode, don't share your sources to keep the response clean but if specifically asked, group all references and links in a "Sources" section at the bottom in the same markdown format (e.g., `[DAU and main takeaway where the metric is referenced](https://app.amplitude.com/...)`) to keep the main response clean.
- Do not quote exact full Amplitude links in the main sections. Concisely reference the chart, metric, or entity name instead so it's easy to read the main sections.
- Flag metrics that changed more than 10% week-over-week
- Note any charts with data quality issues
- Always attribute findings to specific charts when possible
- For the Recommendations section, each recommendation should just be 1 concise but actionable bullet-point instead of a long theme overview
- Do not recap what you did at the very end and just end after the concise prioritized recommendations
- Do not infer trends from incomplete periods or unreliable data
