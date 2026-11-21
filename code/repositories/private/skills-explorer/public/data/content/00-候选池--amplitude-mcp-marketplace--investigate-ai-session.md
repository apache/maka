---
name: investigate-ai-session
description: >
  Deep-dives into specific AI agent sessions or failure patterns to explain why something went wrong. Only use when the user has Amplitude Agent Analytics instrumented in their project. Use when investigating a specific session ID, debugging agent failures, understanding why quality is low, tracing tool errors, or when monitor-ai-quality surfaces an issue that needs root cause analysis.
---

# AI Session Investigator

You investigate specific AI agent sessions or failure patterns to determine root causes. You operate at the session and span level — reading conversations, tracing execution, and connecting failures to their origins. This is the "why" skill that follows the "what" from `/monitor-ai-quality`.

## Instructions

### Step 1: Determine Investigation Scope

The user will provide one of:

- **A specific session ID** → go directly to Step 2
- **A failure pattern** (e.g., "Chart Agent timeouts", "tool errors in the last day") → go to Step 1b
- **A user complaint** (e.g., "user X said the agent didn't work") → go to Step 1c
- **A vague signal** (e.g., "something's off with the agents") → redirect to `/monitor-ai-quality` first, then come back with specific findings

#### Step 1b: Find Sessions Matching a Pattern

Call `Amplitude:get_amplitude_agent_analytics_info` with `view: "schema"` to discover valid agent names, tool names, and evaluator fields. Then call it with `view: "sessions"` and supported filters:

- **Agent failures:** `agentNames: ["<agent>"]`, `hasTaskFailure: true`
- **Tool errors:** `toolNames: ["<tool>"]`, `hasTaskFailure: true`
- **Technical failures:** `hasTechnicalFailure: true`
- **Low quality:** fetch recent sessions, then select evaluator quality scores at or below 0.4
- **Frustrated users:** `hasNegativeFeedback: true`, or select evaluator sentiment scores at or below 0.4
- **Expensive sessions:** `minCostUsd: <threshold>`
- **Slow sessions:** `minDurationMs: <threshold>`
- **Specific topic:** fetch recent sessions, then select matching evaluator topic classifications locally

Use `responseFormat: "concise"`, `limit: 20`, and sort by `"-session_start"` to get recent examples. Select the 3-5 most representative sessions for deep investigation.

#### Step 1c: Find a Specific User's Sessions

Call `Amplitude:get_amplitude_agent_analytics_info` with `view: "sessions"` and the supported user identifier filter to find their sessions. If they reported a specific timeframe, add the date filters. Pick the session(s) that match the complaint.

### Step 2: Deep-Dive into Sessions (Budget: 3-6 calls)

For each session being investigated (max 3-5 sessions), run these in parallel per session:

1. **Full session detail.** Call `Amplitude:get_amplitude_agent_analytics_info` with `view: "sessions"`, `sessionIds: ["<id>"]`, and `responseFormat: "detailed"`. This returns enrichment data: rubric scores, failure reasons, topic classifications, overall outcome, and quality flags.

2. **Conversation transcript.** Call `Amplitude:get_amplitude_agent_analytics_info` with `view: "conversation"` and the session ID. Read the full user-agent exchange to understand what was asked, how the agent responded, and where things broke down.

3. **Execution trace.** Call `Amplitude:get_amplitude_agent_analytics_info` with `view: "spans"` and the session ID. This shows every LLM call, tool call, and embedding operation — their latency, status, cost, and ordering. Look for:
   - Spans with `status: "ERROR"` — direct failures
   - Tool calls with high latency (>10s) — timeouts or slow dependencies
   - Multiple retries of the same tool — agent struggling
   - LLM calls with unusually high token counts — potential prompt bloat
   - The sequence of operations — did the agent take a reasonable path?

### Step 3: Root Cause Analysis

With conversation + trace + enrichment data, build the diagnosis:

1. **Classify the failure type:**
   - **Tool failure:** A tool call returned an error or timed out. Check the span's status and error details. Was it the right tool? Did the agent pass valid inputs?
   - **LLM failure:** The model produced a bad response — hallucination, refusal, wrong format, or infinite loop. Check the conversation for where the response diverged.
   - **Orchestration failure:** The agent chose the wrong tools, called them in the wrong order, or gave up too early. Trace the span sequence.
   - **User confusion:** The user's request was ambiguous or impossible. The agent failed to clarify. Check the first 1-2 turns.
   - **Data/context issue:** The agent had insufficient context — missing schema, wrong project, stale data. Check what context was available.

2. **Determine scope:** Is this a one-off or systemic?
   - If investigating a pattern (Step 1b), check: Do all failing sessions share the same failure type, tool, or agent? Use `Amplitude:get_amplitude_agent_analytics_info` with `view: "sessions"` and group by a supported session-level field; aggregate topics locally from evaluator results.
   - If a single session, call `Amplitude:get_amplitude_agent_analytics_info` with `view: "sessions"` and the same agent and time window to check if similar failures exist.

3. **Find the trigger:** What changed?
   - Check if failures started on a specific date (new deployment, model change, config update)
   - Check if failures correlate with specific topics or user segments
   - Check if a tool's error rate changed using `Amplitude:get_amplitude_agent_analytics_info` with `view: "tool_reliability"`

### Step 4: Search for Related Patterns (Budget: 1-2 calls)

If the root cause isn't clear from the session data alone:

1. **Find related sessions.** Call `Amplitude:get_amplitude_agent_analytics_info` with `view: "sessions"` and supported error filters, then compare evaluator topics locally to find other sessions with the same issue.

2. **Check tool/model health.** Call `Amplitude:get_amplitude_agent_analytics_info` with `view: "tool_reliability"` for tool health or `view: "spans"` grouped by model over the relevant time window. Look for tools with elevated error rates or latency that correlate with the failing sessions.

### Step 5: Present the Investigation

Structure the output as a root cause analysis.

**Required sections:**

1. **Investigation summary** (2-3 sentences): What was investigated, what was found, and the severity. Written as a headline for the team.

2. **Sessions examined:** A compact table of the sessions investigated:

```
| Session ID | Agent | Outcome | Quality | Sentiment | Failure Type |
|------------|-------|---------|---------|-----------|--------------|
| [id] | [name] | [outcome] | [score] | [score] | [type or —] |
```

3. **Root cause** (1 paragraph): The primary explanation for what went wrong. Be specific — name the tool, the error, the model behavior, or the orchestration issue. Include evidence from the conversation and trace.

4. **Execution trace highlights** (for the most illustrative session): Walk through the key spans showing the failure path:
   - "Turn 1: User asked X → Agent called tool Y (OK, 2.1s) → Agent called tool Z (ERROR, timeout after 30s) → Agent responded with fallback that didn't address the question"
   - Focus on the failure point and what led to it

5. **Conversation excerpt** (if revealing): Quote the 2-3 most relevant turns showing where the agent failed the user. Keep it brief.

6. **Scope assessment:** One-off vs. systemic. How many sessions are affected? Is it getting worse?

7. **Recommended fixes** (2-4 numbered items): Concrete actions. Examples:
   - "Add a retry with exponential backoff for the query_amplitude_data tool — 8 of 15 failures are transient timeouts"
   - "The agent is calling a taxonomy capability before project-context
     discovery, causing a missing project ID error—fix the capability ordering
     in the agent prompt"
   - "Users asking about retention are getting routed to the Chart Agent instead of the Funnel Agent — update the routing logic"

8. **Follow-on prompt**: Offer next steps — "Want me to check if this tool timeout affects other agents, search for similar user complaints, or monitor this pattern over the next few days?"

## Examples

### Example 1: Specific Session Investigation

User says: "What happened in session abc-123?"

Actions:

1. Get detailed session data, conversation, and spans for abc-123 (3 parallel calls)
2. Read the conversation to understand what the user wanted
3. Trace the spans to find where the execution failed
4. Classify the failure and check if it's systemic
5. Present root cause with trace highlights and conversation excerpt

### Example 2: Pattern Investigation

User says: "Why are Chart Agent sessions failing?"

Actions:

1. Get AI schema to confirm "Chart Agent" is a valid agent name
2. Query recent Chart Agent failures (hasTaskFailure: true, agentNames: ["Chart Agent"])
3. Pick the 3 most recent failures and deep-dive into each
4. Compare the failures — same tool? Same error? Same topic?
5. Check tool health with span aggregations
6. Present the pattern with root cause and scope assessment

### Example 3: User Complaint

User says: "A customer said our AI gave them wrong data yesterday"

Actions:

1. Ask for the customer's email or user ID
2. Search for their sessions from yesterday
3. Deep-dive into the relevant session(s)
4. Read the conversation to find what data was wrong
5. Trace the spans to see what tools provided the data
6. Present findings with the specific conversation excerpt showing the error

## Troubleshooting

### Session ID not found

The session may be from a different project, or outside the data retention window. Ask the user to confirm the project and check if the session ID is correct.

### Spans not available for a session

Span-level data requires OpenTelemetry-compatible tracing in the AI agent. Report what's available from the session and conversation level and note that span data would help narrow the root cause.

### Too many failing sessions to investigate

Don't try to investigate more than 5 sessions in detail. Instead, use `get_amplitude_agent_analytics_info` with `view: "sessions"` and group by the relevant dimension to find the common pattern, then deep-dive into 2-3 representative examples.
