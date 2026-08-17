# Extension Events, Middleware, Services, and Timers

These contributions live in the `runtime` section of `maka.extension.json` and
execute in the Runtime Host process. See
`extension-package-platform.md` for the trust model and package format.

Custom Events declare a namespaced JSON-schema contract and one dispatch mode:
`emit`, `parallel`, `serial`, `bail`, `transform`, `observe`, `gate`, or
`around`. Listeners are ordered by priority, Extension id, Revision, and id.
Payload validation happens before delivery. Listener failures are contained by
the dispatch report where the selected mode permits it.

Around middleware receives `(value, context, next)`. It can wrap, transform, or
short-circuit downstream execution; `next()` can be called at most once. Core
around seams include `maka.tools.execute` and `maka.llm.stream`, whose values
remain live and may contain functions, `AbortSignal`, streams, or async
iterables. Other core seams are declared in `extension-core-events.ts`.

Services validate method input and output schemas. A plugin may call its own
Service or a provider declared in `dependencies`; recursive calls and nested
Event emissions are bounded. Timers retain Host-owned persistent schedules,
advance the next deadline before invocation, collapse missed intervals, and do
not create Agent Turns.

An Event does not wake an Agent or replace the durable `RuntimeEvent` ledger.
`ScheduledTask` remains the authority for scheduled conversational work. There
is no separate Extension Hook manifest or registry; interception is expressed
as a listener on a core Event.
