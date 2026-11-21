---
name: use-amp-guides-surveys
description: Lists Amplitude Guides and Surveys or reads one item's full configuration with `use_amp_guides_surveys`.
x-amp-flags: [mcp-read-guide-survey-external, mcp-consolidate-guides-surveys]
---

# Use Amp Guides Surveys

## Choose an action

- `list` (default): discover or compare guides and surveys with project, type, platform, creator, date, archive, and pagination filters.
- `get`: read one guide or survey's rollout, targeting, triggers, variants, and step content.

## Required inputs

- Always pass `projectId`; use `get_amplitude_context` first when it is unknown.
- For `get`, also pass `nudgeId`. For `list`, pass only filters supported by the tool and reuse `nextCursor` when more results are available.

## Output and guardrails

Call guides and surveys by those user-facing names, not “nudges.” Link each returned title to its URL; keep lists compact and summarize detailed configuration around the user's question.
