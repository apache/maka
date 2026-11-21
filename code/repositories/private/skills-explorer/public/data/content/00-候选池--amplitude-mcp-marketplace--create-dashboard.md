---
name: create-dashboard
description: Builds comprehensive Amplitude dashboards from requirements or goals, organizing charts into logical sections with appropriate layouts. Use when creating a complete dashboard from scratch or assembling existing charts into a cohesive view.
---

# Create Dashboard

Create new team or initiative dashboards, organize scattered charts, build executive reporting, or set up review cadence dashboards.

## Instructions

### Step 0: Discovery (if unfamiliar with the feature)

Before building, understand what you're tracking:

- Search for existing dashboards/charts related to the topic
- Inspect the connected catalog and use its taxonomy search/read capabilities
  to find relevant events and segmentation properties; never guess names or
  scopes
- Ask user for clarification on primary goals, key segments, or time horizons

### Step 1: Define Dashboard Purpose

Clarify:

- Who is the audience?
- What decisions will it inform?
- How frequently will it be reviewed?
- What's the narrative structure?

### Step 2: Gather or Create Charts

**If existing charts found (>5 relevant):**

- Use `Amplitude:search_amp_entities` to find relevant existing charts
- Use `Amplitude:get_amplitude_charts` with `include: "definition"` to retrieve their definitions
- Identify gaps that need new charts

**If few/no charts exist (<5 relevant):**

- Switch to "greenfield build" mode
- Use `Amplitude:query_amplitude_data` to create needed charts
- Keep the returned chart edit IDs; `use_amp_dashboards` promotes them when creating the dashboard
- Consider searching for relevant events first with entityTypes: ["EVENT", "CUSTOM_EVENT"]

**Creating new charts:**

- Prototype with `query_amplitude_data` to verify data
- Collect the returned chart edit IDs before creating the dashboard

### Step 3: Plan the Layout

Organize into logical sections:

1. **Summary Row**: Key metrics at a glance (headline view)
2. **Trend Section**: How things are changing
3. **Breakdown Section**: Segments and dimensions
4. **Detail Section**: Supporting analyses

### Step 4: Create the Dashboard

Use `Amplitude:use_amp_dashboards` with `action: "create"` and:

- Clear, descriptive name
- Rows with appropriate heights (375, 500, 625, or 750px)
- Charts sized appropriately (3-12 columns)
- Rich text headers for sections
- Chart display configurations in chartMetas:
  - `metric_only`: Headline KPIs (single number)
  - `series`: Trend lines (default view)
  - `converted`: Funnels (conversion view)
  - `table`: Data tables

### Step 5: Add Context

Include rich text blocks for:

- Dashboard purpose and audience
- How to interpret key metrics
- Links to related resources
- Last updated or review schedule

## Layout Guidelines

| Content Type     | Suggested Width | Suggested Height |
| ---------------- | --------------- | ---------------- |
| Headline metric  | 3-4 columns     | 375px            |
| Trend chart      | 6-12 columns    | 500px            |
| Comparison chart | 6 columns       | 500px            |
| Detailed table   | 12 columns      | 625px            |
| Section header   | 12 columns      | 375px            |

## Best Practices

- Put most important metrics above the fold
- Use consistent chart sizing within rows
- Group related metrics together
- Add explanatory text for complex metrics
- Ask user about focus areas if multiple valid approaches exist
- Create charts in batches to minimize tool calls

## Common Issues

**Query errors (500/400):**

- Simplify: remove complex groupBy, reduce date ranges, avoid nested properties
- Verify events/properties exist using search first
- Use eventsSegmentation with groupBy instead of dataTableV2 for top N lists

**No data returned:**

- Check event names are exact matches (case-sensitive)
- Verify date range covers when events were tracked
- Confirm user segments aren't too restrictive
