---
name: triage-frontend-issues
description: Triage new issues in the Sentry `javascript` project by archiving non-actionable noise. Use when asked to "triage issues", "triage the javascript project", "archive non-actionable issues", "triage new frontend issues", or "clean up the sentry/javascript queue". Operates only on the sentry/javascript project, only archives (never resolves), and always archives with `untilEscalating`.
allowed-tools: Read, mcp__sentry__search_issues, mcp__sentry__get_sentry_resource, mcp__sentry__update_issue
---

# Triage Frontend Issues

Archive non-actionable noise from the `sentry/javascript` issue queue: only archive, always `untilEscalating`, always with a stated reason. Issues that look actionable in our code, or that you cannot confidently classify, must be skipped.

## Hard Rules

These rules override anything else. Do not relax them.

1. **Project scope.** Only operate on `organizationSlug=sentry`, project slug `javascript`. If asked to triage a different project, stop and ask the user to confirm.
2. **Archive only.** The only status mutation permitted is `status=ignored`. Never resolve, never unresolve, never assign, never delete, never bulk-update fields other than status.
3. **Always `untilEscalating`.** Use `ignoreMode=untilEscalating`. Never use `forever`, `forDuration`, `untilOccurrenceCount`, or `untilUserCount`. If the user asks for a different mode, stop and have them archive that issue manually — this skill does not perform non-escalating archives.
4. **Always include a `reason`.** The `reason` must be a short, factual sentence naming the category from `references/archive-criteria.md` (e.g., "Third-party library noise — echarts internals; not actionable in our code").
5. **Never touch issues outside the unresolved queue.** Skip anything with `status` of `resolved`, `ignored`, or `reprocessing`.
6. **Never archive without confirmation.** Build a full plan, show it to the user, wait for explicit approval before calling `update_issue`. A single approval covers the displayed plan only; new batches need new approval.
7. **When in doubt, skip.** If an issue could plausibly be a real bug in our code, do not archive it. Surface it as `needs-human` in the plan with a one-line note.

## Prerequisites

- Sentry MCP authenticated via `mcp.sentry.dev`. Required tools: `search_issues`, `get_sentry_resource`, `update_issue`.
- If `update_issue` is not available, stop and ask the user to authenticate the Sentry MCP server.

## Inputs

`$ARGUMENTS` is one of:

| Input shape                                                                | Meaning                                                                                            |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Sentry issue URL (`https://sentry.sentry.io/issues/JAVASCRIPT-…`)          | Triage that single issue.                                                                          |
| Issue short ID (`JAVASCRIPT-…`)                                            | Triage that single issue.                                                                          |
| Sentry issue query (contains a colon, e.g. `is:unresolved firstSeen:-24h`) | Use as the search query.                                                                           |
| Empty                                                                      | Use the default triage queue: `is:unresolved is:unassigned firstSeen:-7d`, sort `new`, limit `50`. |

If `$ARGUMENTS` is ambiguous, ask the user to clarify before searching.

## Workflow

### 1. Load the queue

For single-issue input:

- Call `get_sentry_resource(url=<issue-url>)` or `get_sentry_resource(resourceType='issue', organizationSlug='sentry', resourceId=<shortId>)`.
- Confirm `Project` is the javascript frontend project. If not, stop.

For query/default input:

- Call `search_issues(organizationSlug='sentry', projectSlugOrId='javascript', query=<query>, sort='new', limit=50)`.
- Then call `get_sentry_resource` for each result in parallel to get culprit, substatus, assignee, and stack-frame hints (the search response omits some fields).

Skip immediately if any of these are true on an issue:

- `status` is not `unresolved` (already archived, resolved, or in reprocessing).
- `assignedTo` is set to a human (someone is already owning it).
- `assignedTo` is set to a team other than `frontend`/`issues` and the issue looks team-specific (let the owning team triage).

### 2. Classify each issue

Read `references/archive-criteria.md` for the category taxonomy with recognition heuristics and examples. For each candidate issue, produce one of:

| Decision      | Meaning                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `archive`     | Matches a documented category; include the category name in the reason.                                 |
| `skip`        | Could be a real bug in our code, or insufficient evidence; do not archive.                              |
| `needs-human` | Looks like noise but doesn't cleanly fit a category, or volume is unusually high; flag for user review. |

When evaluating, weight these signals (in this order):

1. **Top non-Sentry-SDK frame.** If the top in-app frame is in `node_modules/`, `chrome-extension://`, a third-party host, or `<unknown>`, this is a strong archive signal.
2. **Title pattern.** Many archives are recognizable from the title alone (see criteria reference).
3. **Volume is not a veto.** Some high-volume issues (10k+ events, thousands of users) are still archive-worthy if the top frame is third-party. Volume alone never forces archive either.
4. **Recency.** Single-event issues older than 30 days with no recurrence are usually noise.
5. **Customer org spread.** If events come from one customer subdomain only (check `customerDomain.subdomain` tag), it is likely customer-environment noise.

### 3. Build the plan

Output one Markdown table to the user, in this exact shape:

```
## Triage plan — sentry/javascript (<N> candidates)

| # | Issue | Title | Volume | Decision | Category | Reason |
|---|-------|-------|--------|----------|----------|--------|
| 1 | [JAVASCRIPT-XXXX](url) | TypeError: ... | 12e/3u | archive | browser-api-noise | Browser clipboard permission denied; not actionable. |
| 2 | [JAVASCRIPT-YYYY](url) | <unknown> | 4945e/123u | needs-human | — | High volume, no title — please review before archiving. |
| 3 | [JAVASCRIPT-ZZZZ](url) | ZodError: ... | 360e/132u | skip | — | Schema validation failure in our code; looks actionable. |
```

Then summarize counts: `N archive / M skip / K needs-human`. End with:

```
Reply `apply` to archive the N issues marked `archive`, `apply N,M,...` to archive a subset, or `cancel` to take no action.
```

### 4. Apply on approval

When the user replies `apply` (or `apply <subset>`):

For each issue in the approved set, call:

```
update_issue(
  organizationSlug='sentry',
  issueId=<shortId>,
  status='ignored',
  ignoreMode='untilEscalating',
  reason=<category-tagged reason from the plan>,
)
```

Run these sequentially (not in parallel). If a call fails, log the failure, continue with the remaining issues, and report the failed IDs in step 5.

If the user replies `cancel` or asks to modify the plan, do NOT call `update_issue`. If they reply with edits ("change row 2 to skip"), rebuild the plan and re-confirm.

### 5. Report

After applying, output:

```
## Triage report

- Archived: N
- Skipped: M
- Needs human review: K
- Failures: F (with issue IDs)

<details><summary>Archived issues</summary>

- JAVASCRIPT-XXXX — <reason>
- ...

</details>
```

## Recovery

- If `update_issue` fails on one item, log the failure and continue with the rest. Report failed IDs at the end.
- If the user notices a wrong archive, the user can unarchive it themselves in Sentry. The skill never reverses its own actions automatically.
- If the user asks "redo the plan with these tweaks" mid-flow, regenerate the plan from scratch — do not assume the previous plan still applies.

## Example reasons (use this voice)

- `Third-party library noise — echarts tooltip; not actionable in our code.`
- `Browser API permission noise — Clipboard writeText denied by user agent.`
- `Customer-environment proxy interference — 200 response treated as error (HTML body from corporate proxy).`
- `Transient backend 5xx — InternalServerError on /api/0/organizations/.../events-meta/; backend transient.`
- `Test/synthetic event — smoke test or security probe, not production traffic.`
- `Wrong project — Prisma/Python error mis-routed to frontend project.`
- `Single-event fluke — 1 event, 1 user, no recurrence in 30+ days.`
- `Browser extension noise — ReferenceError for extension-injected global (DarkReader/WeixinJSBridge).`
