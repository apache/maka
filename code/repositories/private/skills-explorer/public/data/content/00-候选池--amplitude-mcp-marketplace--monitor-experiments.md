---
name: monitor-experiments
description: Monitors all active and recently completed experiments across Amplitude projects, triages them by importance, then runs deep analysis and reporting on the most impactful ones. Use when the user asks to "check on experiments", "experiment status", "experiment review", "what experiments are running", or wants a periodic experiment health report.
x-amp-exclude-when-flags: [mcp-consolidate-flags-experiments]
---

# Experiment Monitor & Report Generator

Scan active and recently completed experiments, surface what needs attention, and report on the ones that matter.

This is a **monitoring** skill — keep output accessible to non-experts. Avoid statistical jargon (no p-values, no power analysis). For deep-dive analysis of a specific experiment, use the `analyze-experiments` skill instead.

---

## CRITICAL: Managing Response Sizes

1. **`get_experiments`: 3-5 IDs max per call.** Filter using `search` results BEFORE fetching.
2. **`query_experiment` responses are large.** Extract only `summary` objects and validity flags. Ignore `timeseries`, `xValues`, bulk arrays.
3. **Metric name resolution**: `search` does NOT match metric IDs in `queries`. Search with `entityTypes: ["METRIC"]`, empty `queries`, `limitPerQuery: 50`, scoped to project. Match IDs from results.

---

## Report Structure

The report has two parts:

1. **Summary & Actions** (top) — One table + action items. Someone should be able to read just this and know the full picture.
2. **Details** (bottom) — Deep-dives on experiments that need attention, briefs on recently decided, one-liners for monitoring experiments, and a needs-setup list.

Do NOT duplicate information between the summary table and the details. The summary table is the single source of truth for the portfolio state. Details expand on specific experiments.

---

## Instructions

### Step 1: Context & Discovery

1. Call `Amplitude:get_amplitude_context`. If multiple projects, ask which to monitor.
2. Search for experiments:

```
Amplitude:search({
  entityTypes: ["EXPERIMENT"],
  appIds: [projectId],
  queries: [],
  sortOrder: "lastModified",
  sortDirection: "DESC",
  limitPerQuery: 50
})
```

3. **Filtering rules — include experiments that are:**
   - **Running and not stale:** Any experiment in a running state that is NOT marked as stale. Stale experiments have gone idle and should be excluded.
   - **Recently decided:** Completed experiments that have a decision recorded AND were modified within the last 14 days. These are worth reviewing to confirm the decision or share learnings.
4. **Exclude:** Drafts, disabled experiments, and stale experiments.

---

### Step 2: Fetch Metadata, Metric Names & Primary Results

1. Call `Amplitude:get_experiments` in batches of 3-5 IDs (only the filtered set from Step 1).
2. Extract: state, dates/duration, variants, metric IDs (primary where recommendation=true), decision, owner.
3. Apply the filtering rules from Step 1 again using the detailed metadata (some fields like stale status or decision may only be available here).
4. Resolve metric names via `Amplitude:search({ entityTypes: ["METRIC"], appIds: [projectId], queries: [], limitPerQuery: 50 })`. Build `{ id: name }` mapping.
5. For experiments that have metrics configured, call `Amplitude:query_experiment({ id: "<id>" })` (no metricIds) to get primary metric results and data quality flags. This data feeds both the summary table and the deep-dives.

**CRITICAL: Never show raw metric IDs to the user.** If a metric name can't be resolved, describe it by its role (e.g., "primary metric", "guardrail metric") — do NOT display strings like "rrgtky08" or "Metric gvgb5efj". Metric IDs are internal identifiers that mean nothing to a human reader.

---

### Step 3: Summary & Actions

This is the top of the report. It should be self-contained — someone reading only this section gets the full picture.

#### Summary table

```
## Experiment Monitor: [Project Name]
Date: [Today] | Project: [Name] ([ID])

| Experiment | State | Duration | Lift | Verdict |
|------------|-------|----------|------|---------|
```

**Column definitions:**

- **Experiment** — Human-readable name (NOT a URL, NOT an ID)
- **State** — Running or Completed
- **Duration** — Days since experiment started
- **Lift** — Primary metric relative lift if available, "—" if no data. For multi-variant, show range (e.g., "-17% to -20%")
- **Verdict** — What to do (see vocabulary below)

**Verdict vocabulary:**

| Verdict                 | When to use                                                        |
| ----------------------- | ------------------------------------------------------------------ |
| **Ship**                | Significant positive primary, guardrails clean, data quality good  |
| **Iterate**             | Positive signal but guardrail regression or quality concern        |
| **Monitor**             | Running, not yet significant, nothing to act on                    |
| **Abandon**             | Significant negative primary, or critical data quality issues      |
| **Decided: Ship**       | Recently completed, team decided to ship                           |
| **Decided: Don't ship** | Recently completed, team decided not to ship                       |
| **Fix config**          | Query error, broken exposure event, or severely imbalanced traffic |
| **Needs metrics**       | Running without metrics — can't evaluate                           |
| **N/A**                 | Survey/nudge deployment, not a feature experiment                  |

#### Action items (immediately after the table)

```
**Act now:**
- [Experiment] — [specific action with owner name]

**Keep watching:**
- [Experiment] — [brief status + when to check back]

**Needs setup:**
- [Experiment] — [what's missing + owner name]
```

Every experiment from the table should appear in exactly one action category. If there are no experiments in a category, omit that category.

---

### Step 4: Details

Below the summary, provide additional detail organized into sections. Each experiment appears in exactly ONE section — no duplication.

#### 4a: Deep-Dives (experiments needing attention)

Deep-dive on experiments with **Ship**, **Iterate**, or **Abandon** verdicts (up to 3). These have significant results worth examining.

For each, output the full report in a single pass:

```
---
## [Experiment Name]
[State] | [Duration]d | Control: [N] / Treatment: [N] | [Link to experiment]
```

**Data Quality (first — before results):**

Check data quality BEFORE reporting metric results. If there are critical issues, the reader needs that context before interpreting any numbers.

If everything passes, one line: "Data quality checks all pass." Then proceed to primary metric.

If issues found, report before the primary metric:

```
### Data Quality: [N issues found]
```

**SRM (Sample Ratio Mismatch):**

- Use the `srmDetected` field from the API response
- If `srmDetected: true`: **always report first and prominently**
- Report: actual split vs. expected split with specific percentages

**Traffic allocation changes:**

- Compare the current variant weights against the cumulative exposure distribution
- If they don't match (e.g., current weights are 100/0/0 but cumulative is 15/70/15), the allocation was changed mid-experiment
- Flag this prominently — it means some variants may no longer be receiving new traffic

**Sample size:**

- <100 per variant: Flag as insufficient — too early for any conclusions
- 100–1,000 per variant: Directional signals only, not enough for confident decisions
- 1,000+: Adequate for analysis

**Validity flags — only report failures:**

| Flag                                              | What it means when it fails                                            | Severity |
| ------------------------------------------------- | ---------------------------------------------------------------------- | -------- |
| `isVariancePositive` = false                      | Metric data is invalid — statistical tests can't run                   | Critical |
| `isConfidenceIntervalNotFlipped` = false          | Calculation error in results — don't trust the numbers                 | Critical |
| `isMeanValid` = false                             | Metric values are broken (NaN/infinite) — can't analyze                | Critical |
| `statsAssumptionsMetForWholeExperiment` = false   | Statistical assumptions aren't met — results may be unreliable         | High     |
| `hasSuspiciousUplift` = true                      | Unusually large effect — may be a measurement error, not a real change | High     |
| `isPointEstimateInsideConfidenceInterval` = false | Internal math inconsistency — results may be wrong                     | High     |
| `isStandardErrorLargeEnough` = false              | Too much noise to get reliable estimates                               | Medium   |

If SRM is detected or a Critical flag fails:

```
⚠️ Results below should be interpreted with caution due to [issue].
```

**Primary Metric:**

```
### [Metric Name]: [Plain-language verdict]

| Variant | Value | Lift | 95% CI |
|---------|-------|------|--------|
| Control | [X] | — | — |
| Treatment | [Y] | [+Z%] | [A% to B%] |

[One sentence plain-language interpretation.]
```

**Framing rules:**

- **Do NOT include p-values.** Non-experts don't know what they mean.
- Use "not significant" instead of "no effect." There may be an effect — the experiment just can't detect it at this sample size.
- Lead with what happened in plain language.

**Verdict words:**

- **Significant positive** — CI entirely above zero, positive lift
- **Significant negative** — CI entirely below zero, negative lift
- **Not significant** — CI includes zero; we can't confidently say there's a real difference yet
- **Trending positive/negative** — Directional signal but CI includes zero; worth watching

Add one sentence on practical significance only if lift is very small (<2%) or very large (>20%).

**Guardrails & Secondary Metrics:**

Call `Amplitude:query_experiment({ id: "<id>", metricIds: [...] })`.

Focus on catching regressions, not narrating every metric.

If no significant regressions: "All guardrails and secondary metrics are clean — no significant regressions detected."

If significant regressions found:

```
- **[Metric Name]:** Significant regression ([−X%], CI: [A% to B%]) — [one sentence on impact]
```

If large directional regressions (>20% relative lift) that aren't yet significant:

```
- **[Metric Name]:** Not significant, but directionally negative ([−X%]) — worth watching
```

Small directional changes that aren't significant should be omitted. If 5+ metrics, note that multiple comparisons increase the chance of false positives.

**Feedback (only if primary is significant):**

Call `Amplitude:get_feedback_insights` with experiment-related keywords. Report 2-3 themes in one line each. If no relevant feedback, skip the section.

**Verdict:**

```
### Verdict: [SHIP / ITERATE / MONITOR / ABANDON]
1. [Primary metric finding — one sentence]
2. [Quality / guardrail status — one sentence]
3. [What to do next — one sentence]
```

**Decision matrix (internal reference, don't output):**

| Signal           | Ship                             | Iterate                                       | Monitor                            | Abandon                                   |
| ---------------- | -------------------------------- | --------------------------------------------- | ---------------------------------- | ----------------------------------------- |
| Primary          | Significant positive + practical | Significant positive but guardrail regression | Not yet significant, still running | Significant negative                      |
| Quality          | All pass                         | Minor flags                                   | All pass or insufficient data      | SRM or critical flags                     |
| Guardrails       | Clean                            | 1 regression needs fixing                     | Clean or not enough data           | Significant regression on critical metric |
| Experiment state | Completed                        | Completed                                     | Running                            | Completed or running                      |

#### 4b: Running Experiments (monitoring, no action needed)

For experiments with **Monitor** verdict, provide a one-line status each:

```
---
### Running Experiments

**[Name]** — Running [X]d, Control: [N] / Treatment: [N]. [Primary metric status — e.g., "trending positive (+3.3%) but not yet significant"]. Data quality clean. [Link]

**[Name]** — Running [X]d, Control: [N] / Treatment: [N]. Too early for conclusions — [reason, e.g., "sample sizes are 100-1,000 range"]. [Link]
```

Keep these tight — one line per experiment. Include the link at the end for anyone who wants to check in Amplitude.

#### 4c: Recently Decided (brief summaries)

For experiments with **Decided: Ship** or **Decided: Don't ship** verdict:

```
---
### Recently Decided

- **[Name]** — [Shipped/Rolled back] on [date] after [X] days. [One sentence on outcome or rationale]. [Link]
```

If the experiment was shipped without metrics or without statistical significance, note that briefly.

#### 4d: Needs Setup

For experiments with **Fix config**, **Needs metrics**, or **N/A** verdict:

```
---
### Needs Setup

- **[Name]** — [Issue description]. Owner: [owner].
- **[Name]** — Survey/nudge deployment, not a feature experiment. No analysis needed.
```

Each experiment appears in exactly one detail section. Do NOT list an experiment in both the summary table actions AND a detail section with the same information — the detail section expands on the action item, it doesn't repeat it.

---

## Edge Cases

- **No experiments:** Report clearly, suggest checking other projects
- **No data (<24hrs):** Note the experiment just started, check back in 7 days
- **SRM detected:** Lead with this in data quality — it can invalidate everything else
- **10+ experiments:** Summary table for all, deep-dive top 3, offer to analyze more
- **Response too large / saved to disk:** Extract `summary` + validity flags only
- **No metrics configured:** List in "Needs Setup" section, don't deep-dive
- **All experiments are stale:** Report that there are no active experiments to monitor
- **Query error from `query_experiment`:** Report the error clearly with the experiment owner's name. Flag as "Fix config" in the summary. Common causes: broken exposure event property, misconfigured experiment key.
- **Traffic allocation changed mid-experiment:** Flag in data quality. Compare current weights to cumulative exposure distribution. Note which variants are no longer receiving traffic.
- **Survey/nudge experiments (NPS, etc.):** Note in summary as N/A. No analysis needed — skip deep-dive.
- **Severely imbalanced traffic (e.g., 5%/95% or 0%/100%):** Flag as "Fix config" — can't run a valid experiment without a meaningful control group. Note in needs-setup with owner.
