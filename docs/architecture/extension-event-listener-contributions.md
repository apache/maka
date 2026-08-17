# Extension Event, Service, and Serverless Timer Contributions

Status: implemented on `feat/extension-hook-contributions`.

## Outcome

MAKA Extensions can define namespaced, JSON-schema Event contracts, subscribe isolated Listeners, provide typed Services, and register durable Host-owned Timers from the same immutable package. Hooks and Events share one dispatch kernel.

```text
Extension or Host explicitly emits an Event
  -> Runtime resolves the active Event contract
  -> payload is schema-validated and cloned
  -> declared dispatch mode selects emit / parallel / serial / bail / transform / observe / gate
  -> one isolated worker invocation per Listener
  -> delivery report contains delivered and contained failures
```

An Event does not wake an Agent, create a Turn, or replace the durable `RuntimeEvent` ledger. A Timer invokes a handler, not an Agent Turn; `ScheduledTask` remains the authority for scheduled conversational work.

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
      "mode": "transform",
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
  "services": [
    {
      "name": "dev.example.notes.store",
      "version": "1.0.0",
      "description": "Typed note access.",
      "methods": [
        {
          "name": "read",
          "handler": "readNote",
          "inputSchema": { "type": "object" },
          "outputSchema": { "type": "object" },
          "timeoutMs": 3000
        }
      ]
    }
  ],
  "timers": [
    {
      "id": "compact-cache",
      "handler": "compactCache",
      "intervalMs": 3600000,
      "initialDelayMs": 60000,
      "timeoutMs": 3000
    }
  ],
  "permissions": { "workspace": "none", "network": false }
}
```

Provided Event names must be inside the package identity namespace. Listeners may subscribe to another package's Event; `maka.extension.json` dependencies can require that provider and make activation/recovery ordering explicit. A package may provide Events, Listeners, or both.

The ESM entry exports one default handler object. Handlers may return values when the Event mode consumes them. Tool, Hook, Listener, Service, and Timer contexts expose authenticated `emitEvent` and `callService` capabilities; the package never receives a general Host RPC object. Every invocation uses a fresh OS sandbox with bounded timeout, abort, output, configuration, filesystem, and network authority.

## Dispatch semantics

- The active profile scope is composed before the Session scope. A Session definition may shadow the same provider Event for that Session.
- Listeners are ordered by Event name, descending priority, Extension id, Revision, and Listener id.
- An emit captures an immutable definition and Listener snapshot. Activation changes affect the next emit, not the current delivery.
- Payload validation fails the emission before any Listener runs.
- Listener failure is contained and returned in a bounded delivery report. Mode semantics decide ordering and short-circuiting.
- Caller abort stops further delivery. Package update, stop, delete, dependency loss, Host drain, and restart use the existing lifecycle disposer and persisted Binding authority.
- Nested emissions are bounded to eight Event hops so cyclic Listener graphs fail in a contained delivery report instead of spawning indefinitely.
- Service input and output are validated against their method schemas. Calls require the provider package to be the caller or a declared dependency, and recursion is bounded.
- Timer state is persisted in `extension-timers-v1.json`. The Host advances `nextRunAt` before invocation (at-most-once), collapses missed intervals to one fire, and cold-starts a sandbox for every fire.

## Core Agent seams

Plugins may subscribe to Host-defined events without redefining them: `maka.agent.pre-step`, `maka.agent.request`, `maka.agent.request-error`, `maka.system-prompt.assemble`, `maka.agent.turn-stopping`, `maka.agent.status`, `maka.session.created`, `maka.session.event`, `maka.session.flush`, `maka.session.disposed`, `maka.subagent.start`, and `maka.subagent.end`. Transform, bail, and observe behavior is fixed by the Host contract.

## Agent surface

- `inspect_events`: core/custom Events, Listeners, Services, Timers, revisions, Bindings, and contracts.
- `define_event`: seal and install one Event/Listener/Service/Timer package.
- `test_listener`: invoke one installed Listener in the real sandbox without activation.
- `test_service` / `call_service`: test an immutable revision or call an active typed Service.
- `emit_event`: schema-validate and synchronously dispatch one active Event in the current Session.
- `manage_event`: activate, atomically update, stop, or delete the Session Binding.

The unified `define_package` and `manage_package` tools include every contribution kind, so all capabilities share one Revision and switch atomically.

## Deliberate non-goals

- No implicit Agent wake or new Turn.
- No durable Event queue, retained topic, or Event replay.
- No long-lived arbitrary plugin process.
- No remote `next()` continuation middleware and no `llm.stream` token interception in this phase.
