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
for await (const item of ctx.remote.stream('weather.observe', input, { sessionId })) {
  // render the newest item
}

ctx.events.on('session.event', { sessionId }, ({ event }) => {
  // update plugin state
});
```

Remote identity is bound by the runtime; a plugin cannot choose another extension or generation.
Event subscriptions are staged effects: they begin only after the complete candidate snapshot
commits and are removed on reload, uninstall, rollback, or Renderer shutdown.

## Product-event allowlist

| Event | Scope | Source |
| --- | --- | --- |
| `session.changed` | global | Session catalog changes |
| `session.event` | one Session | Canonical Session event stream |
| `tool.activity` | one Session | Tool-prefixed canonical Session events |
| `agent.graph.changed` | one Session | Agent Graph change notification |

The allowlist is a public compatibility surface. New product events require an explicit typed
addition rather than exposing arbitrary IPC channels or DOM observation.
