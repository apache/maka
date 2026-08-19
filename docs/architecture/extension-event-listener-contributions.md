# Extension Event, Listener, Hook, Service, and Timer contributions

These contributions are effects of the executable Entry's Fiber and are never
persisted as independent activations.

Events declare payload schemas and dispatch modes: `emit`, `parallel`,
`serial`, `bail`, `transform`, `observe`, `gate`, and `around`. Listeners
are deterministically ordered; recursion depth and timeouts are bounded.

A Hook is a Listener attached to a core Event such as `maka.tools.execute` or
`maka.llm.stream`. Around handlers receive `(value, context, next)`;
`next()` is single-use.

Services expose schema-validated methods. Calls resolve through Context and
declared package dependencies. Cross-package calls without a declared provider
are rejected.

Timers have Host-owned durable scheduling metadata, but their callbacks remain
Fiber-owned effects. Disable/remove stops the active timer, while restart
reattaches the schedule to the reconstructed Fiber. A Timer may call a Service
or emit an Event, but is not itself an Event.

Replacement stages the whole contribution set. Failure publishes none of the
candidate effects and preserves the old Fiber; success switches the set and
then disposes the old effects.
