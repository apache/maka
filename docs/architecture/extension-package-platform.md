# Trusted In-Process Extension Platform

Maka has one Extension product, one immutable content Revision, one lifecycle,
and one package manifest: `maka.extension.json`. A Revision may contribute
Tools, UI, Events, Listeners, Services, and durable Host-owned Timers. The old
per-contribution manifests and remote Worker protocol do not exist.

## Trust model

Enabling executable Extension code is equivalent to running a local
application or Bash command. It may read credentials, access files and the
network, modify Maka behavior, block the event loop, or terminate the Runtime
Host. Manifest permissions, schema validation, and the read-only context API
are approval, audit, and accidental-misuse guardrails; they are not a security
boundary against malicious code.

Installation only validates, seals, and stores bytes. Desktop import shows the
trust warning before install and enable. Activation imports the ESM entry in the
Runtime Host process. One activation owns one module instance, and its Tool,
Listener, Service, and Timer handlers share live module state.

## Manifest

`maka.extension.json` contains product metadata plus optional `runtime` and
`ui` sections:

```json
{
  "schemaVersion": 1,
  "id": "dev.example.notes",
  "version": "1.0.0",
  "dependencies": [],
  "configuration": { "properties": {}, "required": [] },
  "runtime": {
    "entry": "dist/runtime.mjs",
    "tools": [],
    "events": [],
    "listeners": [],
    "services": [],
    "timers": [],
    "permissions": { "workspace": "write", "network": true }
  },
  "ui": {
    "contributions": [],
    "permissions": {
      "network": false,
      "hostState": false,
      "sessionAccess": false
    }
  }
}
```

The Runtime entry exports one default handler object. It is loaded once per
activation. Objects are passed directly: functions, `AbortSignal`, async
iterables, and streams no longer cross a JSON or RPC boundary.

## Composition

### Context runtime

The live Runtime is organized as an owned Context tree rather than one flat
collection of contribution registries. The Runtime Host owns the root;
`profile` and `desktop-ui` are root scopes, Session scopes inherit from the
Profile scope, and every active package Revision is represented by a plugin
Context below its scope.

Each plugin Context is the single owner of its child Contexts, published
capabilities, and runtime effects. Tool, UI, Event, Listener, Service, and
Timer adapters register their cleanup with that Context. Closing a Context
first closes its children and then releases effects in reverse order. Runtime
inspection exposes this same tree, including status, capabilities, effects,
and children, so lifecycle ownership is observable rather than implicit.

The durable Revision/Binding controller remains outside the Context runtime.
It decides what should run and preserves immutable revisions, last-good state,
rollback, and restart recovery. The Context runtime decides how the selected
Revisions compose in the live process. Candidate updates receive a fresh
preparing Context; only a healthy activation becomes active, while failed
candidates close without disturbing the current Context.

The dispatch kernel supports `emit`, `parallel`, `serial`, `bail`, `transform`,
`observe`, `gate`, and `around`. Around listeners receive `(value, context,
next)`, may wrap downstream execution before and after, transform its value, or
short-circuit it. `next()` is single-use.

`maka.tools.execute` wraps the real Tool implementation. `maka.llm.stream`
wraps the live model stream, so a listener can transform streaming events with
native async-iterable backpressure and cancellation. Other Agent, Session, and
Subagent seams use the same Event registry. There is no second Extension Hook
registry; external command `PreToolUse` hooks remain a separate user/project
automation adapter.

## Lifecycle and persistence

Revisions remain content-addressed and immutable. Bindings retain activation,
update, last-good rollback, dependency ordering, recovery, and per-scope
configuration. Runtime contributions bind to the Session/Profile scope; UI
contributions bind to `desktop-ui`. A combined transition rolls back if either
scope fails.

Timer schedules remain Host-owned and durable. Timer handlers run through the
same live activation as every other Runtime contribution. Stop/update removes
the registry generation; Turns that already captured a snapshot retain their
generation lease until they finish.

This design deliberately provides no crash containment or hard timeout for
trusted Extension code. Cancellation is cooperative through `AbortSignal`.
