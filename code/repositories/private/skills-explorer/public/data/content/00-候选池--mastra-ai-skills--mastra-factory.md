---
name: mastra-factory
description: "Operate and supervise Mastra Factory through `mastra api factory`. Use for first-time Factory connection and login, status or queue summaries, project and work-item inspection, thread history and memory, metrics, health, decisions, attention, supervisor sessions, and user-authorized autonomous or interactive Factory operations on hosted, local, remote, or self-hosted servers."
license: Apache-2.0
metadata:
  author: Mastra
  version: "1.0.0"
  repository: https://github.com/mastra-ai/skills
---

# Mastra Factory Supervisor

Use `mastra api factory` as the operational control plane for Factory.

## First use: connect before inspecting

Read [`references/connection.md`](references/connection.md). Check CLI availability, establish the user's actual Factory URL, and for platform-hosted deployments run `mastra auth whoami`. If logged out, offer `mastra auth login` rather than silently starting browser login. Local/self-hosted authentication may differ.

An explicit `mastra api --url "$FACTORY_URL" factory project list` works from an empty directory; no deployed repository or `.mastra-project.json` is required. Never assume a shared host, organization, project name, or ID. Preserve the explicit target on subsequent commands.

## Default behavior

For status, inspection, diagnosis, queue review, or recommendation requests:

1. Stay read-only.
2. Select the sole or explicitly named project; report choices when ambiguous.
3. Inspect project state, work items, metrics, thresholds, decisions, attention, and supervisor health/session.
4. Correlate stages, revisions, sessions, decisions, and health findings.
5. Report active/queued work, blocked or unhealthy items, running sessions, pending decisions, human attention, and one recommended next action.
6. Execute a recommendation only when the current request or a previously granted operating scope authorizes it.

## Required reference

Read [`references/factory-supervisor.md`](references/factory-supervisor.md) before running Factory commands for output control, contracts, the read-only workflow, mutation protocol, governance constraints, durable-session limitations, and error handling.

For “my work,” actual execution progress, thread messages, memory, or health interpretation, also read [`references/session-inspection.md`](references/session-inspection.md). Distinguish card stages from running agents, historical messages from current memory, and agent claims from verified repository outcomes.

## Safety boundary

- Never read or reveal `.env`, bearer tokens, saved login contents, or platform/provider credentials.
- Never invent IDs, stages, revisions, request IDs, or sessions.
- Establish the user's operating scope before mutating. Authorization may cover one action or grant standing autonomy over named projects, resources, action types, or objectives.
- Within a clear delegated scope, act without asking for confirmation before every mutation. Ask only when an action is ambiguous, outside scope, or materially more destructive than the granted authority.
- Fetch current state before a write, make the smallest in-scope change, then refetch and report IDs, revisions, and final state.
- Use transitions—not metadata updates—for stage changes, with the current revision and a fresh UUID request ID.
- Never use private HTTP routes to bypass unsupported CLI operations.
- If `work-item start` lacks a supported durable user session, report the block; never substitute the supervisor session or invent a session UUID.
