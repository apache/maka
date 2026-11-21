---
name: tracking-plan-audit
description: Use when auditing Amplitude tracking plans for safe deletion candidates among stale, duplicate, orphaned, cross-app, retired, high-volume, generated-client, never-ingested, or deleted-but-still-emitted events and event properties.
---

# Tracking Plan Audit

Produce a deletion-focused, evidence-backed cleanup inventory. This skill
specializes in deletion audits across telemetry, source code, ownership,
dependencies, and tracking-plan branches. Use `taxonomy` for broad taxonomy
design, naming, metadata, and governance guidance.

Do not add or restore taxonomy objects, make metadata-only changes, or create,
mutate, merge, or delete an Amplitude branch unless the user explicitly asks.

At the start, establish:

- the Amplitude project and environment;
- whether the goal is lower ingestion volume, fewer taxonomy types, or both;
- every repository or directory that may emit the project's data;
- the requested audit mode and lookback window.

## Source-code gate

Source code is required. If the user has not identified every repository or
directory that can emit into the project, ask for those locations before
recommending deletion candidates. You may inventory taxonomy objects while
waiting, but label the result incomplete and do not recommend or execute any
deletion. Before lifting this gate, ask the user to confirm that the supplied
source inventory covers every known emitter.
Never report "no code reference" unless every user-identified source root was
searched.

Do not assume repository names, services, languages, project IDs, event names,
observability systems, or filesystem layouts. Inspect each source root's local
instructions before searching it.

## Route the audit

Choose a primary mode and state it before discovery. Run additional requested
modes sequentially so each keeps its own criteria. Read
[references/modes.md](references/modes.md) for each mode's criteria.

1. General stale events/properties
2. Cross-app overlap
3. Planned but never ingested
4. Global orphan properties
5. Dead generated-client definitions
6. Duplicate events/properties
7. Retired features, routes, flags, or experiments
8. High-volume, low-query instrumentation
9. Code still emitting deleted or blocked events

If the user requests taxonomy changes, also read
[references/mutations.md](references/mutations.md) before any mutation.

## Non-negotiable evidence rules

- Keep telemetry, query/dependency usage, code references, source ownership,
  and taxonomy state as separate signals. No single signal proves deletion is
  safe.
- Audit every identified source root. Include generated clients, direct SDK
  use, wrappers, dynamic dispatch, frontend, backend, mobile, jobs, and
  integrations where present.
- A generated definition is potential usage, not a production call site. Trace
  its method or class through imports, wrappers, registries, aliases, tests,
  and production callers.
- A literal-search miss is insufficient. Check generic trackers, constructed
  names or keys, dictionary spreads, serializers, constants, and
  service-specific clients.
- Determine whether each enclosing code path is reachable through imports,
  route wiring, flags, experiments, jobs, tests, and callers. Distinguish dead
  code from a live feature whose analytics call alone should be removed.
- Recent ingestion with no owner in the known roots indicates an external or
  unidentified source. Report it and ask for another likely source root before
  recommending deletion.
- Check charts, dashboards, cohorts, metrics, experiments, transformations,
  derived properties, lookups, alerts, exports, and other relationships where
  available. A zero saved-query count does not prove there is no dependency.
  If a required dependency surface is unavailable, mark it unresolved and do
  not recommend deletion.
- When retirement or production activity matters, ask which monitoring,
  feature-flag, experimentation, and deployment systems the user has connected.
  Prefer their read-only MCP or app capabilities over assumptions or manual
  screenshots.
- Treat default/system objects and experiment, session-replay, or agent fields
  cautiously unless the selected mode explicitly investigates them.
- Do not expose credentials, property values, PII, customer payloads, or other
  customer-sensitive data. Report aggregates, names only when necessary, and
  access-controlled evidence links.

## Public Amplitude MCP capabilities

Inspect the connected public Amplitude MCP catalog at runtime and use only the
capabilities, action values, parameters, and limits it advertises. Do not
hard-code or invent tool names: public tools can be consolidated, renamed, or
exposed differently during a rollout.

Use the available capabilities to:

- discover accessible projects and ask the user to select one when its ID is
  missing; never infer an ID from a name;
- read raw events and event properties, preferring the consolidated taxonomy
  reader when the catalog exposes one;
- include deleted objects when comparing states or historical ownership;
- select exactly one branch identifier when auditing a tracking-plan branch;
- distinguish project-wide/global properties from properties attached to one
  event using the response's documented scope fields.

For mutation capability selection and exact confirmation behavior, read
[references/mutations.md](references/mutations.md).

## Complete taxonomy reads

For every exhaustive paginated read:

1. Request the largest supported page size, up to 500.
2. Follow every returned cursor until the response says there are no more
   rows.
3. Track unique rows using the response's stable identity plus property/event
   scope, then compare the accumulated count with the API's reported total.
4. Retry transient timeouts and gateway/server failures from the last known
   cursor using bounded retries and backoff appropriate to the connected host.
   Never treat an error payload or failed empty page as completion.
5. If retries are exhausted or counts disagree, report incomplete coverage and
   do not recommend deletions from the partial result.

Use a complete tracking-plan export when available to reconstruct
event-to-property ownership and compare main with a branch. A project-wide
property listing exposes global definitions but may not enumerate every event
attachment. Do not infer ownership from it alone, the export `Action` column,
or branch UI counters; compare taxonomy states explicitly.

## Shared audit workflow

1. Snapshot the relevant main or branch taxonomy and telemetry window.
2. Fully paginate required reads and record coverage against reported totals.
3. Build ownership from complete exports, including active and deleted scopes.
4. Search every identified source root; classify production, dynamic,
   generated-only, test-only, dead, and unknown-external references.
5. Check dependencies and resolve every code, ownership, and source signal.
6. Classify candidates by confidence, evidence, uncertainty, and recommended
   deletion transition.
7. After any event deletion, always perform a global orphan-property sweep.
   Present global property candidates separately and ask for separate explicit
   confirmation; event deletion never authorizes or implies global deletion.

Strong candidates normally have no reachable emitter, no recent ingestion,
little or no query usage, no active owner or dependency, and no unresolved
dynamic or external source. Existing telemetry, dependencies, generic names,
required schemas, or unknown ownership require investigation, not deletion.

For properties, report at least:

```text
property | scope/owners | code references by source | volume/query window | last seen | required | dependencies | confidence | recommendation
```

Also report source coverage, exclusions, unresolved paths, sensitive-data
redactions, and a reviewable batch. Keep mutation batches within the user's
requested limit; otherwise prefer a small first batch.
