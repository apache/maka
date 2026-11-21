---
name: user-cohort-forensics
description: Investigates individual users and user populations in Amplitude — resolve users by email/ID, read profiles, batch-analyze event timelines, spot-check cohort membership. Use for "what did user X do", attribution audits, population sampling, and email-to-user-ID resolution.
---

# User & Cohort Forensics

## The arcs

**Single user deep-dive:** `get_amp_user_data` `include: 'id'` (resolve the
user: email, user ID, device ID, or amplitude ID) → `include: 'profile'`
(lifecycle, acquisition, usage stats) → `include: 'timeline'` (session-aware
event history). `include: 'both'` gets profile + timeline in one call when
you know you'll need both. Summarize journeys; don't dump raw events.

**Population analysis (batched):** build the user set first
(`query_amplitude_data` with a user-ID group_by to rank by volume, or
`use_amplitude_cohorts` `action: 'find'` for a filtered set) →
`get_amp_user_data` `include: 'timeline'` in parallel batches — up to 10
identifiers per call, 10–20 calls in flight is normal for population
analysis; hundreds of calls total is fine. Keep each call narrow (event
types, window) so responses stay small.

**Cohort spot-check:** prefer existing cohorts — `use_amplitude_cohorts`
`action: 'list'` or `action: 'get'` before building ad
hoc definitions. `action: 'membership'` verifies specific users. Check a
member's timeline for the exact markers (purchase, typing, checkout events)
rather than trusting the cohort definition blindly.

**Email → ID resolution:** `get_amp_user_data` `include: 'id'` per email;
uploaded email lists are resolved in batches of ≤10 identifiers per call.
For bulk exports, batch and note the retry pattern on individual failures.

## Parameterization notes

- `include: 'timeline'`: always bound the window (last 30 days by default)
  and pass event-type filters when you know what you're looking for —
  unfiltered timelines are large and slow.
- Rate-limit failures come back flagged `retryable` with `retryAfterMs` —
  back off instead of churning.
- User identity: a user can match multiple IDs (device, user, email). Say
  which identity you resolved and flag ambiguous matches instead of picking
  one silently.
