---
name: analyze-chart
description: Performs deep analysis of a specific Amplitude chart to explain trends, anomalies, and likely drivers. Use when a metric looks unusual, investigating a spike or drop, or understanding the "why" behind numbers.
x-amp-exclude-when-flags: [mcp-consolidate-charts]
---

# Chart Deep Dive

## When to Use

- A metric spiked or dropped unexpectedly
- You need to understand what’s driving a trend
- Preparing a detailed, evidence-backed analysis for stakeholders
- Investigating differences between user or event segments

## Instructions

### Step 0: Identify the Chart

- Accept a chart **URL or chart ID**
- If the user provides a URL, use `Amplitude:get_from_url` to extract the chart ID
- If no chart identifier is provided, ask explicitly for the chart URL or ID and stop

---

### Step 1: Retrieve and Validate Chart Data (Mandatory)

- Use **Reading chart data** to retrieve the chart definition and data
- If chart data cannot be retrieved or is empty, **do not proceed**
  - Explain what’s missing (time range, event, filters, permissions)
  - Ask the user to correct the chart or provide a valid chart

Capture and restate:

- Metric being measured
- Time range and granularity
- Chart type (e.g. time series, funnel, retention)
- Existing filters, segments, or breakdowns

---

### Step 2: Identify the Pattern and Change Window

Use **Analyzing chart** to characterize what’s happening:

- **Spike / Drop**: Sudden change on specific date(s)
- **Trend**: Gradual increase or decrease over time
- **Seasonality**: Recurring weekly or monthly patterns
- **Anomaly**: Deviation from recent baseline or historical behavior

Explicitly identify:

- The **window of change** (start/end)
- Direction and magnitude of the change
- Baseline period used for comparison (default: previous equal-length period)

---

### Step 3: Investigate Likely Drivers (Bounded)

Instead of broad slicing, use **guided segmentation**:

1. Use **Finding the right event properties** to identify the most relevant properties for explaining the change
2. Select **up to 9 high-signal properties** (e.g. platform, country, plan, version)
3. Re-run **Analyzing chart** with these properties in mind to determine:
   - Which segments contribute most to the change
   - Whether the pattern is localized or broad-based
   - Only fetch up to 3 charts at a time when using `Amplitude:query_charts`

Avoid testing more than 9 properties in aggregate unless the user explicitly asks for deeper exploration.

---

### Step 4: Correlate with Context (Required for Anomalies)

For spikes, drops, or unexpected shifts, gather contextual signals in the same timeframe:

- Use **Getting experiments** to identify active experiments or flags
- Use **Getting deployments** to identify releases or rollouts
- Use **Searching for content** to surface annotations or relevant documentation
- Use `Amplitude:get_feedback_insights` to search customer feedback trends that might explain the change
- Use `Amplitude:get_feedback_mentions` to pull in specific customer mentions if there's a likely feedback trend tied to what's being explained.

Determine whether any contextual changes align temporally with the chart pattern.

---

### Step 5: Synthesize Findings

Present a structured, decision-ready analysis:

1. **What Happened**  
   Clear description of the observed pattern and magnitude

2. **When**  
   Exact timeframe and comparison baseline

3. **Primary Hypothesis**  
   Most likely explanation based on chart data and contextual signals

4. **Supporting Evidence**
   - Key metrics
   - Segment contributions
   - Relevant experiments, deployments, or annotations

5. **Alternative Explanations**  
   1–3 plausible alternatives and why they are less likely

6. **Impact**  
   Quantify impact where possible (users, events, conversion, revenue proxy)

7. **Recommended Next Step**  
   One clear follow-up action (e.g. deeper segment, experiment review, instrumentation check)

Always include:

- Chart name
- Chart ID
- Link back to the chart
- Coverage (e.g. properties tested, segments analyzed)

---

## Best Practices

- Always compare against a clear baseline period
- Distinguish **observations** from **hypotheses**
- Prefer high-signal segmentation over exhaustive slicing
- Note data quality issues (low volume, incomplete periods, heavy “(none)” values)
- Do **not** create or edit charts unless the user explicitly asks
