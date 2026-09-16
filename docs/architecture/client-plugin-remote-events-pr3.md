<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Client Plugin Remote and Product Events (PR3)

## Outcome

PR3 closes the first business-capability loop for trusted Client plugins. A Client entry can call
its package's Host service, consume a backpressured Host stream, and subscribe to a deliberately
small set of product events without receiving Renderer Node privileges.

## Host Remote contract

Host entries register Fiber-owned handlers through `ctx.clientBridge.rpc()` and
`ctx.clientBridge.stream()`. Packages declaration-merge their method and stream types into the
maps exported by `@maka/core/client-plugin-bridge`; optional Standard Schema validators enforce the
same input, output, and stream-item contract at runtime.

Every Client request carries the exact active `desktop-ui` fence:

- authority epoch and snapshot revision;
- Client entry and extension identities;
- activation generation;
- package-content and Client-bundle digests.

Runtime Host compares the whole fence against a fresh active snapshot before resolving a Host
handler for that extension. A stale UI generation therefore fails with `operation_conflict`
instead of crossing into a newer package generation.

Streams use explicit `open`, `next`, and `close` operations. The Host retains at most 32 streams per
connection, permits only the owning connection to pull or close them, and closes the bindings when
the connection or owning plugin Fiber retires.

## Client contract

The public Client context adds:

```ts
await ctx.remote.call('weather.refresh', input, { sessionId });
const abort = new AbortController();
for await (const item of ctx.remote.stream('weather.observe', input, { sessionId, signal: abort.signal })) {
  // render the newest item
}

ctx.events.on('session.event', { sessionId }, ({ event }) => {
  // update plugin state
});
```

The SDK binds Remote identity to its current snapshot. The Host verifies that generation before
capturing the specific Remote registration, then runs plugin code outside the platform mutation
queue. Retirement aborts the caller's wait even when an asynchronous handler ignores cancellation;
late replies are discarded and late stream iterators are closed. This does not preempt synchronous
plugin code or undo its side effects.

Desktop snapshots and stream handles retain their originating Host scope. Session calls un-project
the Desktop Session key and reject a Session belonging to a different Host instead of forwarding a
foreign generation fence. Existing streams do not move when the selected Host changes.

These fences validate generations, not mutually untrusted caller identities: Client bundles share
a trusted Renderer realm. The event allowlist is an API compatibility surface, not per-plugin data
authorization.

Event subscriptions, effects, and styles registered during activation are staged until commit.
Registrations made by mounted components after activation start immediately. Explicit disposal
runs cleanup once; reload, uninstall, rollback, or Renderer shutdown clean up remaining effects.
Registration after instance disposal is rejected.

## Product-event allowlist

| Event | Scope | Source |
| --- | --- | --- |
| `session.changed` | global | Session catalog changes |
| `session.event` | one Session | Canonical Session event stream |
| `tool.activity` | one Session | Tool-prefixed canonical Session events |
| `agent.graph.changed` | one Session | Agent Graph change notification |

The allowlist is a public compatibility surface. New product events require an explicit typed
addition rather than exposing arbitrary IPC channels or DOM observation.

## Stream cancellation and renderer lifetime

Stream options accept a Client-local `AbortSignal`. Aborting rejects a pending
pull with the signal's reason without waiting for the producer to yield; calling
an iterator's `return()` instead finishes the pending pull. If cancellation wins
a race with opening the remote stream, the late handle is immediately closed.
Plugin retirement cancels its Client streams. Host retirement aborts the handler
signal and retires the binding even when a producer ignores cancellation; Host
plugins must still use that signal to stop their own external work.

Stream close is idempotent after exhaustion or retirement. A live stream can
still only be closed by its owning connection. Desktop additionally closes
streams and Session observation/transcript registrations when their renderer
document navigates or crashes; reloading a WebContents cannot accumulate the
previous document's listeners and read replicas. Same-document and child-frame
navigation preserve the current subscriptions.
