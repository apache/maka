---
name: live-data-forensics
description: Investigates live product issues against Amplitude data — "is X firing today", "did the release break Y", "which users are affected by Z". Covers the verify-then-query loop, query_amplitude_data parameterization, and its common failure modes. Use for incident analysis, instrumentation checks, and affected-user discovery.
---

# Live Data Forensics

The most common multi-tool job on this MCP server: verify live event
behavior, quantify impact, find affected users. Calls observed in the wild
follow one arc — follow it too.

## The arc

1. **Context.** `get_amplitude_context` (no args) → again with `projectId`.
   Do not guess project IDs.
2. **Reuse before rebuild.** `search_amp_entities` for existing analyses of the same
   area — saved charts already encode correct event names and segments.
3. **Verify taxonomy before querying.** Inspect the connected catalog and use
   its current taxonomy reader to confirm candidate event names, status, and
   queryability, then read event, user, or group properties for exact names
   **and scope**. Never guess names—a wrong name returns a well-formed chart
   with empty data, which reads as "zero".
4. **Check the event is live.** `check_for_recent_event_ingestion` confirms
   first-seen/last-seen before you query — a silent event means the chart
   will be empty no matter how correct the definition is.
5. **Quantify.** `query_amplitude_data` bursts — one slice per call (by
   version, by reason property, by platform), not one mega-query. Prefer the
   typed `chart` parameter (`kind: 'segmentation'`, events + where/group_by +
   date_range); it compiles server-side and validation + taxonomy checks run
   automatically — no separate pre-flight call needed. Compare prod vs
   staging/UAT projects when the question is environment-specific.
6. **Find affected users.** `query_amplitude_data` with a user-ID group_by
   to rank affected users → `use_amplitude_cohorts` `action: 'find'` for the
   full set.
7. **Reconstruct timelines.** `get_amp_user_data` `include: 'timeline'` per
   user, batched (10–20 parallel calls is normal for population analysis;
   the tool accepts up to 10 identifiers per call).

## query_amplitude_data parameterization (this is where most errors come from)

- **Compile errors are self-serve.** The typed path fails with a 400 naming
  the offending field plus a fix hint — fix that one field and retry, don't
  rebuild. The three seen most: relative range whose unit doesn't match
  `interval` ("Last 3 Years" at weekly interval — re-denominate as
  "Last 156 Weeks" or change the interval); funnel `conversion_window`
  missing `unit`; unknown filter operator for that chart kind (use `set`
  for presence — works in every kind).
- **Date range is required** — set `date_range` explicitly, either
  `{relative: "Last 30 Days"}` or `{start, end}` epoch seconds, never both.
  Sub-daily intervals only allow short windows (`hour` caps ~8 days); daily
  granularity caps around 30 days.
- **Every filter needs a valid operator and matching scope** — take `op`
  and `scope` from the taxonomy lookup, not intuition. A scope mismatch
  ("property X is not tracked on this event_type") means you used a user
  property as an event property or vice versa.
- **Segments combine property conditions and behaviors** — `where` (property
  conditions) plus `performed` ("users who did event ≥N times in a window").
  Omit `segments` entirely for all users.
- **Raw `definition` fallback** (composition, revenueLtv, advanced params):
  on failure the response embeds the chart-type schema with valid enums and
  a working example — fix from that and retry.
- `read ETIMEDOUT` is a backend timeout — narrow the date range/filters and
  retry once.

## What to report back

- Whether the event fires at all, volume, and since when (first-seen).
- Impact: affected-user count and share of active users.
- The slices that matter (version, platform, reason property).
- Affected-user evidence: top users by volume + 2–3 reconstructed timelines.
