---
name: create-chart
description: Creates Amplitude charts from natural language descriptions, handling event selection, filters, groupings, and visualization choices. Use when you know what you want to measure but prefer not to build the chart manually.
x-amp-exclude-when-flags: [mcp-consolidate-charts]
---

# Create Amplitude Chart

Create charts from natural language by discovering events, building chart definitions, and verifying results.

## Planning First (Critical)

Before any tool calls, decompose the request:

**1. Identify chart components:**

- Chart type and metric (what's being measured)
- Time range (default: Last 30 Days if not specified)
- Primary event (the action being counted)
- Segment conditions (user filters/groups)
- Filters, groupings, breakdowns
- Funnel steps (if conversion analysis)

**2. Plan event searches:**

- ONE search per distinct event concept
- Never combine multiple concepts in one search
- Example: "purchase" and "signup" need separate searches

**3. Plan parallel tool calls:**

- Get context, search events, find cohorts can run together
- Wait for results before building definition

## Event Discovery (Critical: Discovery First)

**IMPORTANT: Cast a wide net before narrowing down**

When the user's request is ambiguous or could map to multiple events:

1. Search BROADLY first to discover relevant options
2. Review relevant results - look for related events, custom events, meta events
3. Present options to user OR explain your selection rationale
4. Try not to assume a single event is the only answer without exploration

**Search for events:**

```
Amplitude:search with entity_types=['EVENT', 'CUSTOM_EVENT']
```

- Search ONE concept at a time
- Use broad search terms first (e.g., "AI" not just "AI chat")
- ✓ Good: "user completes purchase"
- ✗ Bad: "signup or purchase events"

**Make informed decisions, then explain:**

1. Search broadly to discover all options
2. Review results and identify the most comprehensive/accurate approach
3. Make your best judgment call (prefer aggregated custom events over single events)
4. **Always explain**: "I found X, Y, Z options. I chose [X] because [reason]. This includes/excludes [scope]."
5. User can correct if your assumption was wrong

**Decision criteria:**

- Prefer custom events that aggregate related activity (e.g., "[2026] Activation Metric [AI events only]")
- If no aggregated event exists, choose the primary interaction event
- Consider what "active user" typically means for that product area
- Default to broader scope unless user specifies narrow focus

**Examples:**

- ❌ BAD: User asks "weekly AI users" → immediately pick "ai-chat: send message" without exploring, no explanation
- ✅ GOOD: User asks "weekly AI users" → search "AI", find Ask AI, Agents, Visibility, custom aggregated event. Respond: "I found AI activity across Ask AI, Agents, and Visibility. I'm using the '[2026] Activation Metric [AI events only]' custom event which includes all AI product interactions. This gives you total AI users across all features. Let me know if you want to focus on a specific AI product instead."

**Verify before use:**

- Get existing charts using the event via search
- Check event has actual volume (not zero/stale)
- Look for custom events that aggregate related activity
- If zero results, search for alternatives

**Get properties:**

```
Use the connected catalog's taxonomy property reader for exact names and scopes
```

**Find cohorts:**

```
Amplitude:search with entity_types=['COHORT']
Amplitude:get_cohorts to get full definitions
```

## Chart Type Selection

| Chart Type           | Use When                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `eventsSegmentation` | Counting events/users over time, trends, comparisons, KPIs, distributions, property analytics                                      |
| `funnels`            | Multi-step conversion analysis with a **known sequence**, drop-off analysis, time between specific events, time-to-convert metrics |
| `retention`          | User return behavior, cohort retention curves, churn analysis                                                                      |
| `dataTableV2`        | Tabular comparisons, rankings, multi-dimensional breakdowns                                                                        |
| `customerJourney`    | Path exploration, discovering **unknown paths** users take, comparing converted vs dropped-off paths                               |
| `sessions`           | Session duration, session frequency, time spent per user, session length distributions                                             |

### Quick Reference

**eventsSegmentation** - Most versatile. Use for:

- User counts (DAU, WAU, MAU) with `uniques` metric
- Event totals, averages, sums of properties
- Percentiles, distributions, formulas
- Time series with rolling windows

**Aggregation Scope (eventsSegmentation):**

- `PROPSUM(A)` / `metric: "sums"` = Global sum across ALL events
- `metric: "frequency"` = Distribution of per-user event counts (how many users did it 1x, 2x, 3x)
- For "distribution of property sum per user": Amplitude does not support this directly. Use `metric: "frequency"` for event count distributions, or use dataTableV2 grouped by user_id with PROPSUM, then export for external analysis.

**funnels** - Conversion analysis with **predefined steps**. Use for:

- Step-by-step conversion rates when you know the expected sequence
- Ordered or unordered sequences
- Time-to-convert (median time between events)
- Exclusion events, conversion windows
- Overlapping events: To find users who performed multiple events (in any order), use a funnel with "any order" and set the conversion window to match the chart date range
- Note: If you want to **discover** what paths users take, use `customerJourney` instead

**retention** - Return behavior. Use for:

- N-day or rolling retention curves
- Cohort analysis (new vs returning users)
- Start event → Return event patterns

**dataTableV2** - Tabular data. Use for:

- Breakdowns by dimensions (country, platform, etc.)
- Multi-metric comparisons in table format

**customerJourney** - Path exploration and discovery. Use for:

- Understanding the actual paths users take (vs. expected paths in funnels)
- Analyzing paths starting with, ending with, or between two specific events
- Comparing converted vs dropped-off user paths side by side
- Discovering unexpected navigation patterns or friction points
- Exploring path frequency, similarity, or average time to complete
- Bridging the gap between ideal customer journeys and actual user behavior

**sessions** - Session-based engagement metrics. Use for:

- Session duration analysis (average length, time spent, distributions)
- Session frequency (average sessions per user, total sessions)
- Time spent per user over time
- Events performed within sessions (average events per session)
- Comparing session behavior across user segments

**Special metrics:**

- User counts: `metric: "uniques"`
- Event counts: `metric: "totals"`
- Property sums: `metric: "sums"` with property in `group_by`
- Rates/percentages: Use when comparing groups of different sizes

**Meta events:**

- `_active`: Any active event (DAU, MAU)
- `_new`: New users (first-time event)
- `_any_revenue_event`: Revenue events

## Chart Definition Structure

**Core parameters (all chart types):**

```json
{
  "name": "Descriptive Chart Title",
  "projectId": "12345",
  "definition": {
    "app": "12345",
    "type": "eventsSegmentation",
    "params": {
      "range": "Last 30 Days",
      "events": [
        {
          "event_type": "Purchase Completed",
          "filters": [],
          "group_by": []
        }
      ],
      "metric": "uniques",
      "countGroup": "User",
      "interval": 1,
      "segments": [{ "conditions": [] }]
    }
  }
}
```

**Key parameters:**

- `countGroup`: "User" (unique users) or "Event" (event occurrences)
- `interval`: 1 (daily), 7 (weekly), 30 (monthly)
- `segments`: User filters/groups (empty array = all users)

**Event filters (inline OR logic):**

```json
"filters": [{
  "group_type": "User",
  "subprop_key": "country",
  "subprop_op": "is",
  "subprop_type": "event",
  "subprop_value": ["United States", "Canada"]
}]
```

> `group_type` here is the **counting entity** ("User", or a group like
> "org id") — not the scope of the property. To filter on an account-level
> property, set `subprop_type` to `"group"` and `group_type` to the group type
> that owns it, using the exact name from the active taxonomy reader's
> group-property surface. Never prefix
> the property name with `grp:`. If the response is
> `Invalid group property … for group type …`, that pair is not queryable in
> this project — do not retry variants; use a user- or event-level equivalent.

**User segments (conditions AND logic):**

```json
"segments": [{
  "name": "Active Users",
  "conditions": [{
    "type": "property",
    "group_type": "User",
    "prop_type": "user",
    "prop": "plan",
    "op": "is",
    "values": ["Pro", "Enterprise"]
  }]
}]
```

**Cohort segments:**
Search for cohort, get ID, then:

```json
"segments": [{
  "name": "My Cohort",
  "conditions": [{
    "type": "cohort",
    "group_type": "User",
    "cohort_id": "abc123",
    "op": "is_in"
  }]
}]
```

## Workflow: Create Chart

1. **Get context:**

```
Amplitude:get_amplitude_context (for projectId)
```

2. **Discover events** (BROAD search first):

```
Amplitude:search for each distinct concept
- Use broad search terms initially
- Look for all related events, custom events, cohorts
- Review ALL results before selecting
```

3. **Evaluate and decide:**

- Review all discovered events and custom events
- Make informed decision (prefer aggregated events)
- Prepare clear explanation of what you found and your choice

4. **Find similar charts** (see examples):

```
Amplitude:search entity_types=['CHART'] query="similar concept"
Amplitude:get_charts to see definition structure
```

5. **Get properties if needed:**

```
Use the connected catalog's taxonomy property reader
```

6. **Build definition** using discovered names

- Explain event selection rationale in response

7. **Create chart:**

```
Amplitude:query_dataset with full definition
```

8. **Verify results** - check data makes sense

9. **Save chart:**

```
Amplitude:save_chart_edits with editId from query_dataset
```

## Error Handling

**If query_dataset fails:**

- Read error message carefully
- Common issues: incorrect event names, invalid filters, wrong parameter types
- Fix definition and retry
- Verify events exist via search first

**If zero results:**

- Check filters aren't too restrictive
- Verify event has data (search for charts using it)
- Try broader time range
- Check segment conditions

## Best Practices

**Naming:**

- Include metric + time context: "Weekly Active Users Last 90 Days"
- Not: "WAU" or "Users"

**Time ranges:**

- Default to "Last 30 Days"
- Use inclusive ranges for specific periods
- State interpreted range explicitly

**Verification:**

- Always verify event exists before using
- Check similar charts to understand event usage
- Confirm property names and scopes with the active taxonomy reader

**Comparisons:**

- Use segments for comparing user groups on same chart
- Use rates/percentages for different-sized groups

**Always include:**

- Chart URL in response
- What the chart shows
- Key insights from initial data
- Methodology used
