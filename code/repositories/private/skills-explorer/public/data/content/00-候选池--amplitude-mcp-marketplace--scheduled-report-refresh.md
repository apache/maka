---
name: scheduled-report-refresh
description: Refreshes recurring reports (daily briefings, WBRs, experiment briefs) from saved Amplitude content — fetch the dashboard, re-pull its charts, fill gaps with ad hoc queries, summarize deltas. Use for "run the daily/weekly report", "refresh this dashboard's numbers", or scheduled custom-agent report runs.
---

# Scheduled Report Refresh

The dominant _automated_ job on this MCP server: custom agents and
scheduled runs re-pulling a known set of charts and summarizing changes.

## The arc

1. **Anchor on saved content.** `use_amp_dashboards` `action: 'get'`
   (batch ≤3) for the report's chart list, or `get_from_url` if the run
   input is a link. Saved charts are the contract — do not rebuild
   definitions from scratch.
2. **Re-pull data.** `get_amplitude_charts` `include: 'data'`, ≤3 chart IDs
   per call, at the report's granularity (daily for daily/weekly briefs).
   For each chart compare the current period against the trailing baseline
   the report uses.
3. **Fill gaps ad hoc.** `query_amplitude_data` (typed `chart`) only for
   numbers no saved chart covers (a new funnel step, a one-off slice).
4. **Context for movement.** `use_amp_flags` `action: 'list_deployments'` once — recent deploys are
   the first hypothesis for any metric movement.
5. **Report.** Delta table first (metric, current, baseline, % change),
   then notable movers with hypotheses. State explicitly when the current
   period is partial ("today is tracking at X vs Y full-day yesterday").

## Expectations to set

- `get_amplitude_charts` `include: 'data'` on a saved chart returns exactly
  what the UI shows — trust it; don't re-validate every number with
  `query_amplitude_data`.
- Keep definition reads (`include: 'definition'` / `'typed'`) minimal on
  refresh runs — the dashboard chart list plus data is enough unless a chart
  looks misconfigured.
- If a chart errors or returns empty, report it as a broken report item
  rather than silently dropping it — a missing tile in a recurring report
  is itself a finding.
