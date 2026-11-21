---
name: debug-replay
description: >
  Turns bug reports into reproducible steps by finding error sessions in Amplitude Session Replay, extracting interaction timelines, and identifying the common action sequence that precedes the failure. Use when a user reports a bug, an error event spikes, someone says "how do I reproduce this", "what happened to user X", "repro steps", or you need to understand what a user did before an error occurred.
---

# Debug Replay

Investigate bugs by finding session replays where the error occurred, extracting the interaction timeline, and distilling it into numbered reproduction steps an engineer can follow. This skill bridges the gap between "a user reported a bug" and "here's exactly how to reproduce it."

---

## CRITICAL: Tool Reference

This skill operates on three Amplitude Session Replay tools. Use them in this order:

1. **`Amplitude:get_amp_session_replay_info`** with `action: "search"` — Find sessions matching event filters (errors, specific users, time windows). Returns session metadata and replay links.
2. **`Amplitude:get_amp_session_replay_info`** with `action: "list"` — Simple paginated listing when you already have a user/device ID or just need recent sessions. Returns a session replay ID in `device_id/session_id` format.
3. **`Amplitude:get_amp_session_replay_info`** with `action: "events"` — Decode a specific replay into an interaction timeline: navigations, clicks, inputs, scrolls. Pass the ID from the tools above as `sessionReplayId`.

Supporting tools used in this skill:

- **`Amplitude:use_amplitude_cohorts`** with `action: "find"` — Look up users by email, user ID, or other identifiers.
- **Available taxonomy reader** — Inspect the connected catalog and use its
  event and event-property read capabilities to discover valid filter names.
  Never guess names or copy parameters from an older schema.
- **`Amplitude:use_amp_flags`** with `action: "list_deployments"` — Check if error aligns with a recent deploy.

---

## Instructions

### Step 1: Understand the Bug Report

Parse the user's request to extract:

- **Error identifier**: Error message, error event name, or event type (e.g., `[Amplitude] Error Logged`, a custom error event)
- **User identifier** (if provided): Email, user ID, device ID, or account name
- **Time window**: When it was reported or when it started. Default to last 7 days if unspecified.
- **Product area** (if mentioned): Page, feature, or flow where the bug occurs

If the report is vague (e.g., "something is broken in checkout"), ask one clarifying question before proceeding. Do not ask more than one.

### Step 2: Get Context and Find the Error Event

1. Call `Amplitude:get_amplitude_context`. If multiple projects, ask which to investigate.
2. Use the catalog's taxonomy reader to confirm the exact error event name exists in the project. Common patterns:
   - `[Amplitude] Error Logged` — auto-captured JS errors
   - `[Amplitude] Network Request` with status code filters — API failures
   - Custom error events specific to the product
3. If a user identifier was provided, call `Amplitude:use_amplitude_cohorts` with `action: "find"` to look up the user and get their user ID and device ID.

### Step 3: Find Error Sessions

Use `Amplitude:get_amp_session_replay_info` with `action: "search"` to find sessions where the error occurred. Build filters based on what you know:

**If you have a specific user:**

```json
{
  "action": "search",
  "projectId": "12345",
  "userProperties": [{ "name": "gp:email", "is": "user@example.com" }],
  "events": [{ "name": "[Amplitude] Error Logged" }],
  "limit": 5
}
```

**If you have an error message but no specific user:**

```json
{
  "action": "search",
  "projectId": "12345",
  "events": [
    {
      "name": "[Amplitude] Error Logged",
      "withProperty": { "name": "Error Message", "contains": "TypeError" }
    }
  ],
  "limit": 5
}
```

Request 3-5 sessions. More sessions give better pattern extraction; fewer saves context.

### Step 4: Extract Interaction Timelines

For each session found in Step 3, call `Amplitude:get_amp_session_replay_info` with `action: "events"` and the `sessionReplayId`.

- Use `event_limit: 500` for standard sessions
- Use `event_limit: 200` if analyzing 4+ sessions (to manage context)

**What to capture from each timeline:**

- Page navigations (URLs visited)
- Clicks and inputs leading up to the error point
- Any unusual patterns: rapid repeated clicks (rage clicks), long pauses, back-and-forth navigation
- The approximate timestamp where the error likely occurred (look for the last meaningful action before the session ends or the user navigates away in frustration)

### Step 5: Extract Common Repro Path

This is the core analytical step. Compare the timelines from multiple sessions to find the **common prefix** — the shared sequence of actions that precedes the error.

1. **Align timelines by the error point.** Work backwards from where the error appears to occur.
2. **Identify shared actions.** Look for the same sequence of page navigations, clicks, and inputs across sessions.
3. **Note divergences.** Where timelines differ, note the variations — these may indicate multiple trigger paths or optional steps.
4. **Simplify.** Collapse repeated or irrelevant actions (e.g., scrolling) into the minimal set of steps needed.

If only 1 session is available, extract the timeline as-is and note that it hasn't been validated across multiple sessions.

### Step 6: Check Deployment Context

Call `Amplitude:use_amp_flags` with `action: "list_deployments"` once. If an error spike aligns with a recent deploy, note it — this is critical context for the engineer.

### Step 7: Present Reproduction Steps

Structure the output as an engineering-ready bug report.

**Required sections:**

1. **Bug Summary** (1-2 sentences): What's broken, who's affected, since when. Written as a headline an engineer would put in a ticket title.

2. **Environment Context**:
   - Project and platform
   - Time window investigated
   - Number of sessions analyzed
   - Related deployment (if found)

3. **Reproduction Steps** — Numbered, specific, copy-paste-ready:

```
## Reproduction Steps

1. Navigate to [URL]
2. Click [element/area description] at [approximate location]
3. Enter "[value]" in [field description]
4. Click [element/area description]
5. Observe: [error behavior — what the user sees]

**Expected:** [what should happen]
**Actual:** [what happens instead]
```

4. **Error Context** (if available):
   - Error message / type
   - Failing endpoint (if network error)
   - Page where error occurs

5. **Session Evidence**:
   - Replay links for each analyzed session (clickable)
   - Confidence level: **High** (3+ sessions show same path), **Medium** (2 sessions), **Low** (1 session only)
   - Note any variations between sessions

6. **Observations** (optional): Patterns that may help debugging — rage clicks suggesting UI unresponsiveness, long pauses suggesting loading issues, specific input values that trigger the error.

---

## Edge Cases

- **No error events found.** The project may not have auto-capture enabled, or the error may be tracked under a custom event name. Use the available taxonomy event reader to search for error-related events. Report what you find and suggest what to instrument if nothing exists.
- **User not found.** If `use_amplitude_cohorts` with `action: "find"` returns nothing, try searching with alternative identifiers (email domain, partial match). If still nothing, proceed without user filtering and search by error event alone.
- **Sessions found but no replay events.** Some sessions may not have rrweb data (replay disabled, ad blocker, etc.). Skip those sessions and note it. Try the next session.
- **Only 1 session available.** Present the timeline as "unvalidated reproduction steps" with Low confidence. Suggest the user try to reproduce manually to confirm.
- **Error is intermittent.** If sessions show different paths to the same error, present them as separate reproduction paths: "Path A (seen in 3/5 sessions)" and "Path B (seen in 2/5 sessions)."
- **nodeId values can't be resolved.** `get_amp_session_replay_info` with `action: "events"` returns DOM node IDs, not element names. Describe interactions by position (x, y coordinates), page context, and sequence rather than element identity. Use phrasing like "click in the upper-right area of the form" rather than "click the Submit button" unless you can infer from context.

## Examples

### Example 1: User-Reported Bug

User says: "Customer jane@acme.com says the export button doesn't work"

Actions:

1. Get context and confirm project
2. Look up jane@acme.com via `use_amplitude_cohorts` with `action: "find"`
3. Find her recent sessions with `get_amp_session_replay_info` `action: "search"` filtered to her email + any error events
4. Extract interaction timelines from 2-3 sessions
5. Identify the common path: navigates to reports → clicks export → nothing happens (or error)
6. Present numbered repro steps with replay links

### Example 2: Error Spike Investigation

User says: "TypeError errors doubled yesterday, can you get repro steps?"

Actions:

1. Get context, confirm `[Amplitude] Error Logged` exists
2. Find sessions with TypeError in the last 48 hours via `get_amp_session_replay_info` `action: "search"`
3. Extract timelines from 3-5 sessions
4. Compare timelines to find the common action sequence before the TypeError
5. Check deployments for what shipped yesterday
6. Present repro steps anchored to the deployment

### Example 3: Vague Bug Report

User says: "Users are having trouble with checkout"

Actions:

1. Ask one clarifying question: "Do you have a specific error event or user in mind, or should I look for any errors on checkout pages?"
2. Search for error events on checkout-related pages
3. Find sessions, extract timelines, identify friction patterns
4. Present repro steps for the most common failure path
