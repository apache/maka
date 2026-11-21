---
name: analyze-experiment-consolidated
description: Designs A/B tests with proper metrics and variants, analyzes running or completed experiments, and interprets results with statistical rigor. Use when setting up experiments, checking experiment status, analyzing results, or making ship decisions.
x-amp-flags: [mcp-consolidate-flags-experiments]
---

# Experiment Analyst

Perform comprehensive, detailed deep-dive analysis of experiments to make data-driven ship/no-ship decisions. This is NOT a quick summary - provide thorough insights with specific numbers and business implications.

## When to Use

- Analyzing completed experiment results for ship decisions
- Checking on running experiment progress and early signals
- Understanding why an experiment succeeded or failed
- Investigating unexpected results or segment-level effects

---

## Analysis Philosophy

**Be comprehensive, not brief:**

- Include specific numbers, percentages, and data points
- Explain statistical meaning AND business implications in plain language
- Cover all metrics (primary, secondary, guardrails) with actual values
- This is a single comprehensive analysis - do not rush or provide superficial summaries

---

## Instructions

### Step 0: Identify Experiment

**If user provides a specific experiment:**

- Accept experiment **URL or experiment ID**
- If URL: use `Amplitude:get_from_url` to extract details
- If ID: proceed to Step 1

**If user asks about experiments generally:**

- Use `Amplitude:search_amp_entities` with `entityTypes: ["EXPERIMENT"]` and relevant query terms
- Present top 3-5 matches with names, IDs, and states
- Ask user which experiment to analyze

**If no experiment specified:**

- Ask explicitly for experiment URL, ID, or search terms and stop

---

### Step 1: Retrieve and Validate Setup

Use `Amplitude:use_amp_experiments` with experiment ID to capture:

- Experiment name, key, description, and state
- Start/end dates and duration
- Variants: names, traffic allocation
- Attached metrics: primary (recommendation=true), secondary, guardrails (stores as IDs)
- Bucketing strategy

**Get metric names:**

- Extract metric IDs from the experiment response (e.g., "c4pn8fkv")
- **CRITICAL: Amplitude MCP cannot retrieve metric names by ID directly**
- Workaround options:
  1. Search for experiment-related charts using `Amplitude:search_amp_entities` with `entityTypes: ["CHART"]` and experiment name
  2. Use `Amplitude:get_amplitude_charts` with `include: "definition"` on related charts to examine their definitions for metric references
  3. Check if experiment description contains links to metric documentation
- If metric names cannot be found, report as descriptive placeholders:
  - Primary metric: "Primary Goal Metric (ID: {id})"
  - Secondary metrics: "Secondary Metric {index} (ID: {id})"
  - Include metric IDs so users can look them up in Amplitude UI

**Validation:**

- Is experiment running or completed? (not draft)
- Has it run for 1+ weeks?
- Are variants and metrics clearly defined?

If incomplete, explain what's missing and stop.

---

### Step 2: Check Data Quality (with explicit thresholds)

**Assignment-segment queries (the hard part, learned from production sessions):**
when you need ad hoc per-variant numbers outside `analyze` (entry-point
funnels, custom slices, cross-checks against another warehouse):

- Discover the assignment event first with the connected catalog's taxonomy
  search capability for the experiment's flag key and `search_amp_entities`
  for existing charts that filter on it—do not guess the event name.
- Read how an existing experiment chart structures its variant segments
  (`get_amplitude_charts` with `include: "typed"` on one) and copy that
  pattern exactly — including the bucketing property (`subject_id_type`
  varies per experiment).
- Verify assignment volume before analyzing: `query_amplitude_data` for unique
  assignments per variant since launch. Zero or lopsided assignment =
  bucketing/ramp problem, not a metric result.

Use `Amplitude:use_amp_experiments` (primary metric only) to assess:

**Traffic Balance (SRM Check):**

- Report actual traffic split per variant (e.g., 48.2% control, 51.8% treatment)
- **Use `srmDetected` field from API:** Flag if `srmDetected: true`
- SRM (Sample Ratio Mismatch) indicates the observed traffic split deviates significantly from the expected allocation
- If SRM detected, report the expected vs. actual allocation with specific percentages
- Severe SRM can indicate instrumentation issues or bucketing problems that may invalidate results

**Sample Size Analysis:**

**A. Current Sample Assessment:**

- Report total users per variant with specific numbers
- **Flag if <100 users per variant** (insufficient for any conclusion)
- **Flag if 100-1000 users** (directional signals only, not confident decision)
- Need 1000+ per variant for confident decisions

**B. Statistical Power Analysis:**

- **Target effect size:** What minimum lift would be meaningful for the business? (typically 2-5% for conversion metrics)
- **Achieved power:** Given current sample size and observed variance, what's the probability of detecting the target effect if it exists?
- **Power interpretation:**
  - <50%: Severely underpowered - likely to miss real effects
  - 50-70%: Underpowered - high risk of false negatives
  - 70-80%: Marginally adequate - consider extending if p-value is borderline
  - 80%+: Well-powered - sufficient to detect target effect size
- **If underpowered:** Calculate additional sample size needed to reach 80% power
- **Recommendation:** If power <70% and results are inconclusive, extend duration rather than making premature decision

**C. Precision Analysis (Confidence Interval Width):**

- **CI width for primary metric:** Report the width of the 95% confidence interval as percentage of baseline
- **Precision assessment:**
  - CI width >10% of baseline: Low precision - effect size uncertainty too high for confident decisions
  - CI width 5-10% of baseline: Moderate precision - acceptable for directional decisions
  - CI width <5% of baseline: High precision - narrow enough for confident decisions
- **Actionability threshold:** Is the CI narrow enough to distinguish between practically significant and negligible effects?
  - If lower CI bound suggests meaningful lift but upper bound is marginal, precision may be insufficient
  - Example: If target is +5% lift and CI is [-2%, +12%], too wide to confidently conclude effect exceeds target
- **Recommendation:** If CI too wide, extend duration or increase traffic allocation to improve precision

**Comprehensive Data Quality Flags:**

The `Amplitude:use_amp_experiments` API returns multiple boolean flags that assess statistical validity. Check and document each:

1. **statsAssumptionsMetForWholeExperiment:**
   - Indicates whether core statistical assumptions are satisfied (normality, independence)
   - **If false:** Results may not be reliable; consider non-parametric approaches or longer runtime
   - Impact: High - affects all statistical conclusions

2. **hasSuspiciousUplift:**
   - Flags unexpectedly large effect sizes that may indicate data quality issues
   - **If true:** Verify instrumentation, check for bot traffic, or segment anomalies
   - Impact: High - may indicate measurement error rather than real effect

3. **isVariancePositive:**
   - Confirms metric variance is positive (mathematically required for statistical tests)
   - **If false:** Critical data quality issue - metric may be constant or incorrectly computed
   - Impact: Critical - statistical tests invalid if false

4. **isConfidenceIntervalNotFlipped:**
   - Ensures lower CI bound < upper CI bound (mathematical consistency check)
   - **If false:** Indicates calculation error or data corruption
   - Impact: Critical - results cannot be trusted

5. **isStandardErrorLargeEnough:**
   - Checks if standard error is sufficient for reliable inference
   - **If false:** High variance or very small sample may produce unreliable confidence intervals
   - Impact: Medium - affects precision of estimates

6. **isPointEstimateInsideConfidenceInterval:**
   - Validates that point estimate falls within its confidence interval (consistency check)
   - **If false:** Calculation error or numerical instability
   - Impact: High - indicates statistical computation issues

7. **isMeanValid:**
   - Confirms mean value is a valid number (not NaN, not infinite)
   - **If false:** Data quality issue - check for null values or computation errors
   - Impact: Critical - cannot analyze if mean is invalid

**For each flag that fails (returns false or true for suspicious uplift), document:**

- Which flag failed
- What it means in plain language
- Specific impact on result reliability
- Recommended action (extend duration, investigate instrumentation, etc.)

**If all flags pass:** Note this explicitly as strong data quality signal

**Temporal Stability:**

- Check if primary metric is stable day-over-day
- Note ramp period (first 24-48hrs) or day-of-week effects

**Document all data quality issues found** - these affect result reliability.

---

### Step 3: Analyze Primary Metric

Use `Amplitude:use_amp_experiments` **without metricIds** to get primary metric only.

**Use metric name from Step 1** - Report using the human-readable metric name, not the metric ID.

Extract and report:

- **Control baseline:** metric value and sample size
- **Treatment performance:** metric value and sample size
- **Absolute lift:** treatment - control
- **Relative lift:** (treatment - control) / control × 100%
- **P-value:** with interpretation
- **Confidence interval:** report 95% CI bounds

**Interpret:**

- ✅ **Statistically significant:** p < 0.05 and CI doesn't include 0
- ⚠️ **Trending:** 0.05 < p < 0.15 (suggestive but inconclusive)
- ❌ **No effect:** p ≥ 0.15 or CI includes 0

**Practical significance:**

- Is the lift magnitude meaningful for the business?
- Small lifts (<2-3%) may not be worth complexity even if significant
- Consider metric's business impact (revenue vs. low-value engagement)

---

### Step 4: Analyze Secondary Metrics & Guardrails

Use `Amplitude:use_amp_experiments` **with metricIds** for all metrics.

**Use metric names from Step 1** - Report using human-readable metric names, not metric IDs.

**For each secondary metric:**

- Report metric name (from Step 1 mapping), variant performance, and statistical significance
- Note which moved and which didn't (with specific numbers)
- **Identify unintended consequences:** Flag any negative impacts with specific values

**For each guardrail:**

- ✅ No regression: neutral or positive (p > 0.05)
- ⚠️ Marginal concern: small negative lift (1-5%) with p < 0.10
- 🚩 **Significant regression:** negative lift with p < 0.05 - report actual numbers

**Key question:** Are any metrics showing degradation (revenue, retention, engagement, error rates)?

**Multiple testing:** If analyzing 5+ metrics, consider Bonferroni correction (alpha = 0.05 / number of metrics)

---

### Step 5: Comprehensive Segment Analysis

Use `Amplitude:use_amp_experiments` with `groupBy` parameter (one at a time).

Test 3-4 high-signal segments:

1. **Platform** (iOS, Android, Web)
2. **User tenure** (new vs. established users)
3. **Plan type** (free vs. paid)
4. **Geography** (country, region)

**MANDATORY: Format results as markdown breakdown tables**

For each segment analysis, present results in this exact format:

| Segment | Control Rate | Control Exposures | Control % of Total | Treatment Rate | Treatment Exposures | Treatment % of Total | Relative Lift | Significant? |
| ------- | ------------ | ----------------- | ------------------ | -------------- | ------------------- | -------------------- | ------------- | ------------ |
| iOS     | 48.7%        | 1,234             | 45.2%              | 55.4%          | 1,456               | 54.8%                | **+13.6%**    | Yes (p=0.02) |
| Android | 63.9%        | 567               | 20.8%              | 65.1%          | 589                 | 22.2%                | +1.9%         | No (p=0.45)  |
| Web     | 51.2%        | 928               | 34.0%              | 50.8%          | 611                 | 23.0%                | -0.8%         | No (p=0.89)  |

**Calculate % of Total:**

- Sum all exposures across segments to get total
- Show each segment's share: (segment exposures / total exposures) × 100%
- This reveals which segments drive overall results

**Key insights:**

- Identify segments where treatment performs **best** (targeted rollout opportunity)
- Identify segments where treatment **hurts** (consider exclusions)
- Explain why different segments show different performance
- **Watch for Simpson's Paradox:** Overall result may differ from all segment results

Use `groupByLimit: 10` to avoid overwhelming output.

---

### Step 6: Assess Duration & Runtime Sufficiency

**Duration Assessment:**
Based on the power and precision analysis from Step 2, evaluate if the experiment has run long enough:

**Runtime factors:**

- **Minimum duration:** Has experiment run at least 1-2 weeks to capture full user lifecycle?
- **Learning effects:** For feature changes, have users had time to adapt? (typically 3-7 days)
- **Weekly seasonality:** Has experiment captured at least one complete week to account for day-of-week patterns?
- **Business cycles:** For B2B products, has it run through full business week patterns?

**Integration with Step 2 power analysis:**

- **If Step 2 showed adequate power (>80%) AND p < 0.05:** Experiment has sufficient data, duration is adequate
- **If Step 2 showed low power (<70%) AND p > 0.05:** Inconclusive due to insufficient data, extend duration
- **If Step 2 showed adequate power (>80%) AND p > 0.15:** Sufficient data to accept null result (no effect)
- **If Step 2 showed adequate power but CI width too wide:** Need more data for precision, extend duration

**Velocity projection (only if extending recommended):**

- **Current daily enrollment:** Calculate users per day per variant
- **Days to target sample:** Based on Step 2 power calculation, how many more days needed?
- **Days to target precision:** Based on Step 2 CI width calculation, how many more days to reach desired precision?
- **Recommendation:** Provide specific date when experiment should reach sufficient power/precision

**Do NOT repeat the power calculations from Step 2** - reference those findings and focus on duration and timeline recommendations.

---

### Step 7: Understand Why (Qualitative Context)

**For significant results (positive or negative):**

Use `Amplitude:use_amplitude_ai_feedback` with `facet: "insights"`:

- Filter by experiment date range
- For wins: look for `["lovedFeature", "mentionedFeature"]`
- For losses: look for `["bug", "complaint", "painPoint"]`
- Check if themes align with experiment hypothesis

**Connect quantitative to qualitative:**

- Explain the lift with user quotes or feedback themes
- Present 2-3 representative examples with specific details

---

### Step 8: Synthesize Findings and Make Recommendation

**Before finalizing, verify you have included:**

- ✓ All primary metric data (lift, CI, p-value, interpretation)
- ✓ All data quality findings (SRM, sample size, power, precision, all 7 validity flags with actual values)
- ✓ All secondary metrics and guardrails (with actual values and significance)
- ✓ All segment analysis tables (formatted with % of total exposures)
- ✓ Statistical power assessment (current power, required sample, duration)
- ✓ Qualitative insights (feedback themes)

Present structured analysis:

---

## Experiment Analysis: [Experiment Name]

**Overview:**

- **Hypothesis:** [What was tested and expected impact]
- **Duration:** [Start] to [End] ([X days])
- **Sample Size:** Control: [N] | Treatment: [N]
- **Link:** [Experiment URL]

---

**Data Quality Assessment:**

**Traffic & SRM:**

- **Traffic Balance:** Control [X%] | Treatment [Y%] (Expected: [X%] | [Y%])
- **SRM Detected:** [Yes/No] [If yes, explain deviation severity]

**Sample Size & Power:**

- **Sample Size:** Control: [N] | Treatment: [N]
- **Sample Adequacy:** [Adequate (>1000) / Moderate (100-1000) / Low (<100)]
- **Statistical Power:** [X%] to detect [Y%] lift (Target: 80%+)
- **Achieved Precision:** 95% CI width = [±X%] ([High <5% / Moderate 5-10% / Low >10%])

**Statistical Validity Flags:**
[Only include flags that failed - if all pass, state "All statistical validity checks passed"]

- ❌ **statsAssumptionsMetForWholeExperiment:** Statistical assumptions not met - [brief impact]
- ❌ **hasSuspiciousUplift:** Unusually large effect detected - [brief recommendation]
- ❌ **isVariancePositive:** Invalid variance - [critical issue description]
- ❌ **isConfidenceIntervalNotFlipped:** CI calculation error - [critical issue description]
- ❌ **isStandardErrorLargeEnough:** Insufficient standard error - [impact on precision]
- ❌ **isPointEstimateInsideConfidenceInterval:** Statistical inconsistency - [calculation issue]
- ❌ **isMeanValid:** Invalid mean value - [data quality issue]

**Duration:**

- **Runtime:** [X days] (Started: [date])
- **Sufficiency:** [Adequate - captured full user lifecycle / Need more time - [reason]]
- **Recommendation:** [Continue running for X more days / Sufficient data to conclude]

**Overall Data Quality:** [Excellent / Good / Concerns / Critical Issues]
[One sentence summary of whether results can be trusted]

---

**Primary Metric: [Metric Name]**

| Variant   | Value | Lift      | 95% CI   | P-value | Status         |
| --------- | ----- | --------- | -------- | ------- | -------------- |
| Control   | [X]   | —         | —        | —       | —              |
| Treatment | [Y]   | **[+Z%]** | [[A, B]] | [P]     | ✅ Significant |

**Interpretation:** [1-2 sentences on statistical AND practical significance]

---

**Secondary Metrics & Guardrails:**

**Guardrails:**

- ✅ **Revenue per user:** No regression ([+X%], p=[P])
- ✅ **Retention D7:** Slight positive ([+X%], p=[P])
- 🚩 **Bounce rate:** Regression detected ([+X%], p=[P]) ⚠️

**Secondary Metrics:**

- **[Metric]:** [+X% lift, p=[P]] - [brief interpretation]
- **[Metric]:** No significant change (p=[P])

**Unintended Consequences:** [List any negative impacts on secondary metrics or guardrails]

---

**Segment Analysis:**

**By Platform:**

| Segment                                   | Control Rate | Control Exp | Control % | Treatment Rate | Treatment Exp | Treatment % | Lift | Sig? |
| ----------------------------------------- | ------------ | ----------- | --------- | -------------- | ------------- | ----------- | ---- | ---- |
| [Data from query_experiment with groupBy] |

**Key Finding:** [Which segments drove results; which showed differential effects]

**By User Tenure:**
[Similar table]

---

**Statistical Power:**

- **Current Power:** [X%] - [Adequate/Underpowered]
- **Required Sample:** Need [X] more users per variant for 80% power
- **Estimated Duration:** [X] more days at current traffic to reach significance

---

**Why This Result:**

- **[Feedback theme]** ([X mentions])
  - "[Quote]" - [Source] ([Date])

---

**Recommendation: ✅ SHIP** / **⚠️ ITERATE** / **❌ ABANDON** / **🔄 NEED MORE DATA**

**Rationale:**

1. [Primary metric result with statistical and practical significance]
2. [Guardrail status and any unintended consequences]
3. [Segment insights - opportunities or concerns]
4. [Power analysis - adequate data or need more time]
5. [Qualitative validation]

**Known Risks:**

- [Risk 1 with mitigation if shipping]
- [Risk 2 with mitigation if shipping]

**Next Steps:**

1. [Specific action based on recommendation]
2. [Follow-up or monitoring action]

---

**Key Takeaways (3-5 actionable insights):**

1. [Most important finding]
2. [Second most important finding]
3. [Third most important finding]
4. [Additional insight if relevant]

---

---

## Key Scenarios & How to Handle

### Inconclusive Results (p > 0.05)

**Diagnose:**

- Check statistical power: Is sample size adequate? Report current power percentage
- Check confidence interval: Very wide = high variance, need more data
- Check segments: Effect may exist in specific subgroup

**Action:**

- If power <60%: Extend duration or increase traffic allocation
- If power >80% but p >0.15: Accept null result (no effect detected)
- Check segment tables: Look for subgroups with significant effects

---

### Guardrail Regressed

**Diagnose:**

- Quantify trade-off with specific numbers: +10% conversion but -2% retention
- Which segments drove the regression? Check segment tables
- Is regression statistically significant or just noise?

**Action:**

- Small regression + large primary win + not significant = ship with monitoring
- Significant regression on critical metric = iterate to fix or abandon
- Segment-specific regression = consider targeted rollout excluding affected segments

---

### Segment Tables Show Opposite Effects

**Simpson's Paradox detected:**

- Overall result may be misleading if segments show opposite directions
- Example: Overall +5% lift, but iOS -10%, Android +15%

**Action:**

- Report the paradox clearly with specific segment numbers
- Consider targeted rollout to segments that benefit
- Exclude or iterate for segments that are harmed

---

## Best Practices

**Comprehensive analysis:**

- ✅ Include ALL data from tool calls with specific numbers
- ✅ Format segment analysis as breakdown tables with % of total
- ✅ Check statistical power and duration adequacy
- ✅ Verify data quality before drawing conclusions
- ✅ Connect quantitative results to qualitative insights

**Statistical rigor:**

- ✅ Report confidence intervals, not just p-values
- ✅ Distinguish statistical vs. practical significance
- ✅ Apply multiple testing correction for 5+ metrics
- ✅ Check for Simpson's Paradox in segment analysis

**Avoid:**

- ❌ Don't provide brief summaries - be comprehensive
- ❌ Don't omit data quality issues or negative secondary metrics
- ❌ Don't ignore segments - they reveal critical insights
- ❌ Don't make recommendations without adequate power
- ❌ Don't stop analysis early because primary looks good

---

## For Experiment Design

If user wants to **design a new experiment**, guide them through:

1. **Define hypothesis:** "We believe [change] will cause [users] to [behavior] because [reason]"

2. **Select metrics:**
   - Use `Amplitude:search_amp_entities` with `entityTypes: ["METRIC"]` to find candidates
   - Primary: directly measures hypothesis
   - Guardrails: revenue, retention, core engagement (prevent unintended consequences)

3. **Estimate sample size:**
   - Typical: 1-2 weeks minimum, 1000+ users per variant
   - Higher variance metrics need more data
   - Use `Amplitude:query_amplitude_data` to check the metric's historical variance

4. **Create experiment:**
   - Use `Amplitude:use_amp_experiments` with projectIds, variants, and metrics
   - Return experiment ID, URL, and deployment key for engineering

For detailed setup guidance, consider using the `setup-experiment-and-flags` skill.
