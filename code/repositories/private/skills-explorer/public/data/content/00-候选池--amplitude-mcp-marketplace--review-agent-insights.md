---
name: review-agent-insights
description: >
  Retrieves, synthesizes, and prioritizes all recent AI agent results from Amplitude. Queries every agent type available in get_agent_results, validates freshness, and produces a unified narrative ranked by impact. Use when the user asks "what has the AI found", "show me agent insights", "any AI findings", "what did Amplitude discover", "review AI insights", or wants a digest of everything Amplitude's AI agents have surfaced recently.
---

# Review Agent Insights

Surface everything Amplitude's AI agents have found recently. Query **every available agent type** in `get_agent_results`, validate for staleness, and synthesize into a unified narrative ranked by impact with concrete follow-up actions.

---

## CRITICAL: Tool Reference

**Primary tool:**

- **`Amplitude:get_agent_results`** — Retrieve pre-computed analyses from Amplitude's AI agents. Supports multiple agent types (check the tool's `agent_type` enum for the current list). Each agent type is queried separately. All support filtering by `created_after`, `created_before`, `query`, `agent_params`, and `limit`.

**Supporting tools:**

- **`Amplitude:get_amplitude_context`** / **`Amplitude:get_amplitude_context`** — Bootstrap user, org, and project info.
- **`Amplitude:use_amp_flags`** with `action: "list_deployments"` — Check whether fixes have shipped for flagged issues (staleness validation).

---

## Instructions

### Step 1: Bootstrap Context (1-2 calls)

1. Call `Amplitude:get_amplitude_context` to get the user's org, projects, recent activity, and key dashboards. If multiple projects, ask which to review — or review all if the user wants a broad scan.
2. Call `Amplitude:get_amplitude_context` for the target project's settings and AI context.

Determine the **review window** from the user's request:

- Default: **last 7 days** (good balance of recency and coverage).
- "What's new today?" → last 1-2 days.
- "Catch me up on this month" → last 14-30 days.
- Always compute the `created_after` ISO 8601 timestamp for the review window.

### Step 2: Query All Agent Types (parallel)

Check the `get_agent_results` tool descriptor to discover every available `agent_type` in the enum. **Make one call per agent type, in parallel.** For each:

- `agent_type`: the agent type from the enum
- `created_after`: the review window timestamp from Step 1
- `limit: 10`

If the user asked about a specific area (e.g., "onboarding insights"), add a `query` matching that area to every call. If an agent type supports additional filtering via `agent_params` (e.g., impact ratings, categories, dashboard IDs), use them to focus results when the user's request suggests a narrower scope — otherwise omit `agent_params` to get the broadest view.

For each result returned, note:

- Which agent type produced it
- The key findings or summary
- When the analysis was run (creation date)
- Any metadata specific to that agent type (impact ratings, categories, dashboard IDs, etc.)

If exactly 1 result is returned for an agent type, artifacts auto-expand. If multiple results, note the previews and fetch full artifacts for the 2-3 most relevant ones (by recency or by matching the user's focus area) using `session_id`.

If any agent type returns fewer than 3 results and supports `agent_params` filtering, consider a second call with relaxed filters to broaden coverage.

### Step 3: Validate Freshness

Agent insights go stale within days. Before synthesizing, filter out or flag anything unreliable.

1. **Check creation dates.** For each finding, note how old it is relative to today:
   - **< 3 days old**: High confidence — treat as current.
   - **3-7 days old**: Medium confidence — include but note the age.
   - **7-14 days old**: Lower confidence — include only if no newer findings cover the same area. Label as "may be outdated."
   - **> 14 days old**: Stale — exclude from the main narrative. Mention in passing only if nothing newer exists for that area.

2. **Cross-reference with deployments (1 call).** Call `use_amp_flags` with `action: "list_deployments"` once. For each AI-detected issue, check if a deployment shipped a fix or change to the affected area after the analysis was run. If so, note the finding as "potentially resolved by [deployment]" rather than presenting it as an active issue.

3. **Deduplicate across agent types.** The same problem may surface from multiple agent types. Merge these into a single finding with multi-agent evidence — don't present the same issue multiple times.

### Step 4: Synthesize and Rank

1. **Rank by impact and evidence strength.**
   - Multi-agent findings (flagged by more than one agent type) rank highest.
   - High-impact or high-confidence findings from a single agent type rank next.
   - Low-impact or older findings rank lowest.

2. **Group by theme, not by agent type.** Organize findings by product theme or problem area ("Checkout flow," "Onboarding," "Search feature"), not by which agent produced them. Within each theme, weave together evidence from all contributing agent types.

3. **Identify gaps.** Note agent types that returned no recent results, or product areas with no coverage.

### Step 5: Present the Review

Structure the output as a narrative digest that a PM could forward to their team.

**Required sections:**

1. **Summary** (3-4 sentences): Which agent types were queried, the review window, how many results total, the single most important finding, and overall assessment.

2. **Key Findings** (3-7 items, ranked by impact):

For each finding:

```
### [Finding Title — action-oriented, ≤10 words]
**Impact:** [Critical/High/Medium/Low] | **Agents:** [list agent types that contributed] | **Freshness:** [X days old]

**What the AI found:** Describe the insight — what anomaly, friction, or issue was
detected. Be specific about the product area and the evidence from each agent.

**Staleness check:** Note if deployments shipped after the analysis, or if the finding
needs fresh validation. Omit this line if the finding is < 3 days old.

**Recommended action:** One concrete next step.
```

3. **Coverage Gaps** (2-4 items): Agent types with no results, or product areas with no AI coverage. For each, suggest what to do — which agent to run and on what.

4. **Follow-on prompt**: End with 2-3 specific options for what to dig into next, framed around the findings.

**Writing standards:**

- Narrative over structure. Write findings as paragraphs, not database records.
- Lead with the insight, use agent type attribution as supporting evidence.
- Approximate: "~42%" not "42.37%".
- Active voice only.
- Always state the freshness: "detected 2 days ago" not "recently found."
- Link to Amplitude UI sessions/artifacts inline when URLs are available in the results.
- Total length: 400-800 words for the main findings. Be concise.

---

## Edge Cases

- **No results from any agent type.** Report that no recent AI agent analyses were found. List the agent types that were queried and suggest the user run them on their key dashboards and flows.
- **Results from only one agent type.** Present what you have and note which agent types had no results. Frame the gap as an actionable recommendation.
- **All results are stale (> 14 days old).** Present a brief summary with clear staleness warnings and recommend re-running analyses.
- **Overwhelming number of findings.** Cap at 7 key findings. Rank by impact × freshness × evidence breadth. Mention the total count.
- **User asks about a specific area.** Add a `query` parameter to every agent type call. Present only relevant findings.
- **Unrecognized agent type results.** If a new agent type returns results in a format you haven't seen before, present the raw findings with the agent type name and any available metadata. Don't skip results just because the agent type is unfamiliar.

## Examples

### Example 1: Broad Review

User says: "What has the AI found recently?"

Actions:

1. Get context — identify key project and dashboards
2. Check `get_agent_results` for all available agent types, query each in parallel with `created_after` set to 7 days ago
3. Validate freshness — cross-reference against deployments, filter out stale findings
4. Synthesize and group by product theme, noting which agent types contributed to each finding
5. Present unified findings ranked by impact, note coverage gaps for agent types with no results

### Example 2: Focused Area Review

User says: "Any AI insights about onboarding?"

Actions:

1. Get context
2. Query all agent types with `query: "onboarding"`, `created_after` set to 7 days ago
3. Filter to only onboarding-related findings
4. Present findings + gap recommendations for agent types that returned nothing for onboarding

### Example 3: Nothing Found

User says: "Show me all AI agent insights"

Actions:

1. Get context
2. All agent type queries return empty within the review window
3. Present: "No AI agent results found in the last 7 days. Here's how to generate them:" — list each agent type that was queried, what it does, and suggest specific content to analyze
