---
name: analyze-ai-topics
description: >
  Analyzes what users ask AI agents about and how well each topic is served. Only use when the user has Amplitude Agent Analytics instrumented in their project. Use when the user asks "what are people asking the AI", "top AI topics", "where is the AI struggling", "AI coverage gaps", "what should we improve in our AI", or wants product insights from AI conversation patterns.
---

# AI Topic Analyzer

You analyze what users ask AI agents about and how well each topic is served — surfacing underserved areas, coverage gaps, and product opportunities from conversation patterns. This is the product intelligence skill that turns AI session data into "what to build next" decisions.

## Instructions

### Step 1: Get Context and Schema

1. **Get context.** Call `Amplitude:get_amplitude_context` to identify projects and user role.
2. **Get AI schema.** Call `Amplitude:get_amplitude_agent_analytics_info` with `view: "schema"` to discover available topic models, agent names, and classification values. The schema tells you what topic dimensions exist (e.g., product_area, intent, error_domain) — these vary by project.
3. **Determine scope.** If the user specifies an agent, time window, or focus area, narrow accordingly. Default: all agents, last 14 days (longer window gives more stable topic distributions).

### Step 2: Map the Topic Landscape

Run these in parallel:

1. **Topic breakdown with quality.** Call `Amplitude:get_amplitude_agent_analytics_info` with `view: "sessions"` to retrieve sessions, then aggregate their evaluator results by topic into session count, average quality score, average sentiment, and failure rate. Limit the output to 50 topics. This is the core dataset.

2. **Agent-by-topic matrix.** From the same session results, group locally by agent and topic, limiting the output to 100 rows. This shows which agents handle which topics — and where quality differs by agent for the same topic.

3. **Volume trend by topic.** Group the session results locally by day and topic. Combine this with the topic breakdown to understand whether total volume growth is driven by specific topics.

4. **Failure sessions by topic.** Call `Amplitude:get_amplitude_agent_analytics_info` with `view: "sessions"` and `hasTaskFailure: true`, then group the returned sessions locally by topic. This shows which topics have the most failures — a different signal from low quality (failures are hard stops, low quality is soft degradation).

### Step 3: Identify Underserved Topics

Score each topic on a 2x2 of **volume x quality**:

|                 | High Quality (>0.7)         | Low Quality (<0.7)                |
| --------------- | --------------------------- | --------------------------------- |
| **High Volume** | Well-served (maintain)      | **Underserved (fix now)**         |
| **Low Volume**  | Niche but working (monitor) | **Gap or emerging (investigate)** |

For each quadrant, identify the top 3-5 topics. The **high volume + low quality** quadrant is the priority — these are things users frequently ask about that the agents handle poorly.

Also flag:

- **Growing topics:** Topics with increasing volume over the time window. These may need better coverage soon even if quality is currently acceptable.
- **Sentiment outliers:** Topics where sentiment is notably lower than quality score. This means the agent technically completes the task but users aren't happy with the experience.
- **Agent routing issues:** Topics where one agent handles them well but another handles them poorly — suggesting a routing improvement.

### Step 4: Deep-Dive into Top Underserved Topics (Budget: 3-6 calls)

For the 2-3 most impactful underserved topics:

1. **Sample conversations.** Select representative sessions for the topic from the evaluator results, then call `Amplitude:get_amplitude_agent_analytics_info` with `view: "conversation"` for 3-5 examples to understand:
   - What specifically are users asking?
   - Where does the agent struggle — wrong answer, no answer, wrong tool, slow response?
   - Are there sub-patterns within the topic?

2. **Detailed failing sessions.** Call `Amplitude:get_amplitude_agent_analytics_info` with `view: "sessions"` and `hasTaskFailure: true`, then select up to 5 sessions for the topic or with evaluator quality scores at or below 0.5. Read the enrichment data for failure reasons and rubric scores.

3. **Tool usage for the topic.** Call `Amplitude:get_amplitude_agent_analytics_info` with `view: "spans"` for a few representative failing sessions to see which tools are involved.

### Step 5: Synthesize into Product Insights

Transform the analysis into actionable product decisions.

**Required sections:**

1. **Topic landscape summary** (3-4 sentences): How many distinct topics, total session volume, overall quality distribution. Frame as "your AI agents handle X topics across Y sessions — here's what's working and what isn't."

2. **Topic heatmap table** — The core deliverable:

```
| Topic | Sessions | Quality | Sentiment | Failure Rate | Trend | Priority |
|-------|----------|---------|-----------|--------------|-------|----------|
| [topic] | [N] | [score] | [score] | [%] | [↑/↓/→] | [Fix/Monitor/Good] |
```

Sort by priority: Fix items first, then Monitor, then Good. Limit to top 15-20 topics.

3. **Underserved topics** (2-4 findings): Each as a narrative paragraph:
   - **[Topic headline — what users are asking]** — Volume (N sessions), quality score, what goes wrong (from conversation samples), which agent handles it, and what would fix it. Include example conversation excerpts to make it concrete.

4. **Coverage gaps** (1-2 findings): Topics where users are asking questions the agents can't answer at all. Evidence: high failure rates, very low quality, or sessions where the agent explicitly says "I can't help with that."

5. **Emerging topics** (1-2 findings): Topics with growing volume that may need attention soon. Include the growth rate and current quality.

6. **Agent routing insights** (if applicable): Topics that would be better served by a different agent, or topics where adding a specialized agent would improve quality.

7. **Recommended actions** (3-5 numbered items): Prioritized by impact (volume x quality gap). Examples:
   - "Improve the Chart Agent's handling of retention queries — 340 sessions/week at 0.42 quality. Users ask for cohort retention but get event trends. Add retention chart type detection to the agent's routing."
   - "Create a dedicated onboarding agent — 'getting started' topics span 3 agents with inconsistent quality (0.38-0.72). A single agent with onboarding context would unify the experience."
   - "Add better error messages for unsupported query types — 89 sessions/week hit 'I can't do that' dead ends. At minimum, suggest what the user should try instead."

8. **Follow-on prompt**: "Want me to deep-dive into a specific topic, investigate the failing sessions for [top underserved topic], or build a monitoring dashboard for AI topic quality?"

**Writing standards:**

- Lead with the user impact, not the data
- Use conversation excerpts to make abstract topics concrete
- Quantify everything — "340 sessions/week" not "many sessions"
- Every finding needs an action
- Keep the full report under 800 words (topic analysis tends to be richer than operational reports)

## Examples

### Example 1: Full Topic Analysis

User says: "What are people asking our AI about?"

Actions:

1. Get context and AI schema
2. Query topic breakdown, agent-by-topic matrix, volume trends, and failures by topic (4 parallel calls)
3. Score topics on the volume x quality matrix
4. Deep-dive into top 2-3 underserved topics with conversation search and detailed sessions
5. Present the topic heatmap with underserved findings and recommendations

### Example 2: Focused Gap Analysis

User says: "Where is our AI falling short?"

Actions:

1. Get context and schema
2. Query topics and failures — focus on low quality and high failure rate topics
3. For each underserved topic, search conversations to understand the failure mode
4. Present findings organized by severity with concrete fix recommendations

### Example 3: Agent-Specific Topic Review

User says: "What topics does the Chart Agent handle, and how well?"

Actions:

1. Get context, then query sessions grouped by topic for that agent specifically
2. Compare the agent's topic quality scores against the fleet average
3. Deep-dive into the agent's worst topics
4. Present a focused report on that agent's topic coverage

## Troubleshooting

### No topic enrichment data

Topics require session enrichment to be enabled. If topics are empty, use `get_amplitude_agent_analytics_info` with `view: "sessions"` to sample sessions, then `view: "conversation"` to manually categorize common themes. Note the limitation and suggest enabling enrichment.

### Too many topics (>50)

Group similar topics and present the top 20 by volume. Offer to drill into specific clusters on request.

### Topics are too generic

If topic labels are broad (e.g., "data question", "help request"), the enrichment model may need tuning. Note this and use conversation search to identify more specific sub-topics manually.
