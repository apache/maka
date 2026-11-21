---
name: chart-link-analysis
description: Answers questions from an Amplitude chart or dashboard link — fetch the definition, pull the data, explain or adapt it. Use when the user pastes an Amplitude URL, asks "what does this chart show", wants a report refreshed from a dashboard, or wants to clone/adapt an existing analysis.
---

# Chart Link Analysis

Second most common job: the user pastes a link and wants the analysis
understood, refreshed, or adapted.

## The arc

1. **Resolve the URL.** `get_from_url` returns the entity type, IDs, and
   (for charts) the current definition. One call handles chart, dashboard,
   experiment, notebook, and cohort links — use it instead of asking the
   user for IDs.
2. **Read the definition.** For a chart: `get_amplitude_charts` with
   `include: 'typed'` — the typed params mirror the chart-builder UI and are
   the fastest way to see how the project spells events/properties. If
   `typed` fails to lower the chart ("advanced features are not modeled"),
   fall back to `include: 'definition'` for the raw form. For a dashboard:
   `use_amp_dashboards` `action: 'get'` (batch ≤3) to get its chart list,
   then read the charts that matter.
3. **Pull the data.** `get_amplitude_charts` `include: 'data'` with the
   chart IDs, ≤3 IDs per call. For a report refresh, request the granularity
   the report needs (daily for week-over-week, weekly for monthlies).
4. **Adapt or fork.** Edit the typed params, then call
   `query_amplitude_data` with the edited `chart` **and** `chartId` set to
   the saved chart's id — the parent's params fill gaps the typed model
   omits, and the edit stays linked to its parent. Render the result with
   `render_amplitude_chart`; the user saves it from the widget's **Save
   chart** button (there is no model-facing save tool). To replicate a whole
   dashboard in a new context: read the reference dashboard, then rebuild
   each chart — do not try to "copy" in one call.

## Expectations to set

- `get_from_url` does not run the chart — it returns metadata/definition.
  Data always comes from `get_amplitude_charts` `include: 'data'` (saved
  charts) or `query_amplitude_data` (ad hoc).
- `include: 'data'` returns the same numbers the UI shows, including
  Amplitude's timezone bucketing — when comparing against external sources
  (e.g. BigQuery), call out timezone and partial-day differences explicitly.
- Definition reads are cheap; data reads are the expensive calls. Read all
  definitions first, then decide which 1–3 charts actually need data.
- Just need the link for the user? `include: 'link'` (the default) validates
  the ids and returns URLs without running anything.
