# Extension Event and Listener Contributions

Status: implemented on `feat/extension-hook-contributions`.

## Outcome

MAKA Extensions can define namespaced, JSON-schema Event contracts and subscribe isolated Listeners from the same or another Extension package. This is the Runtime-internal event bus that complements typed lifecycle Hooks:

```text
Extension or Host explicitly emits an Event
  -> Runtime resolves the active Event contract
  -> payload is schema-validated and cloned
  -> active Listeners are snapshotted and ordered
  -> one isolated worker invocation per Listener
  -> delivery report contains delivered and contained failures
```

An Event does not schedule work, wake an Agent, create a Turn, or replace the durable `RuntimeEvent` ledger. `ScheduledTask` remains the time-based work authority. Hooks remain curated Runtime middleware; custom Events are explicit plugin-to-plugin notifications.

## Package contract

An Event package adds `maka.event.json` to the same immutable Extension Revision:

```json
{
  "schemaVersion": 1,
  "id": "dev.example.notes",
  "version": "1.0.0",
  "entry": "dist/events.mjs",
  "events": [
    {
      "name": "dev.example.notes.note.changed",
      "description": "A note changed.",
      "payloadSchema": {
        "type": "object",
        "properties": { "id": { "type": "string" } },
        "required": ["id"],
        "additionalProperties": false
      }
    }
  ],
  "listeners": [
    {
      "id": "update-index",
      "event": "dev.example.notes.note.changed",
      "handler": "updateIndex",
      "priority": 100,
      "timeoutMs": 3000
    }
  ],
  "permissions": { "workspace": "none", "network": false }
}
```

Provided Event names must be inside the package identity namespace. Listeners may subscribe to another package's Event; `maka.extension.json` dependencies can require that provider and make activation/recovery ordering explicit. A package may provide Events, Listeners, or both.

The ESM entry exports one default handler object. Listener handlers receive the validated JSON payload and the bounded worker context. They return no value. Tool, Hook, and Listener worker contexts expose `await context.emitEvent(name, payload)` over an authenticated dedicated callback pipe; the package never receives a general Host RPC object. Event emissions must be awaited before the handler returns. Each invocation uses the same required OS sandbox, timeout, abort, output limits, configuration resolution, and one-shot worker protocol as Tool and Hook packages.

## Dispatch semantics

- The active profile scope is composed before the Session scope. A Session definition may shadow the same provider Event for that Session.
- Listeners are ordered by Event name, descending priority, Extension id, Revision, and Listener id.
- An emit captures an immutable definition and Listener snapshot. Activation changes affect the next emit, not the current delivery.
- Payload validation fails the emission before any Listener runs.
- Listener failure is contained and returned in a bounded delivery report; remaining Listeners still run.
- Caller abort stops further delivery. Package update, stop, delete, dependency loss, Host drain, and restart use the existing lifecycle disposer and persisted Binding authority.
- Nested emissions are bounded to eight Event hops so cyclic Listener graphs fail in a contained delivery report instead of spawning indefinitely.
- Events are at-most-once, in-process notifications. They have no replay ledger, retry queue, retained state, or background worker.

## Agent surface

- `inspect_events`: active Event contracts, Listeners, revisions, Bindings, and package contracts.
- `define_event`: seal and install one Event/Listener package.
- `test_listener`: invoke one installed Listener in the real sandbox without activation.
- `emit_event`: schema-validate and synchronously dispatch one active Event in the current Session.
- `manage_event`: activate, atomically update, stop, or delete the Session Binding.

The unified `define_package` and `manage_package` tools also include Event and Listener contributions, so Tool, UI, Hook, Event, and Listener can share one Revision and switch atomically.

## Deliberate non-goals

- No implicit Agent wake or new Turn.
- No timer, cron, durable queue, retained topic, or replay.
- No export of private Runtime events.
- No use of Event results to gate or transform the emitter; use a typed Hook or Service for those semantics.
- No long-lived arbitrary plugin process.
