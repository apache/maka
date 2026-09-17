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

# Client Plugin Runtime and typed Slots contract

This change makes a trusted Renderer bundle part of the same package, immutable
generation, and composition authority as a Host plugin. It also provides a
typed, recursively extensible Slot graph and a compatibility-governed public UI
SDK. The Host Remote and product-event follow-up contract is documented in
`client-plugin-remote-events-pr3.md`.

Installing a package with a Host entry is equivalent to installing arbitrary native code: its
module runs in the main Node.js process with the process's filesystem, child-process, and network
privileges. Only install Host plugins from sources trusted to execute with those privileges.

## Unified package

`maka.extension.json` may declare a Host entry, a Client entry, or both:

```json
{
  "schemaVersion": 1,
  "id": "example.weather",
  "displayName": "Weather",
  "client": { "entry": "dist/client.js" },
  "composition": { "patch": "maka.composition.json" }
}
```

The Client entry is copied into the package's immutable generation. The Runtime
Host hashes that copied file and exposes only the active generation selected by
the `desktop-ui` composition. A package no longer needs a second
`client-plugins` installation directory or a `package.json` Client authority.

`maka.composition.json` mounts the Client package like any other composition
entry:

```json
[
  {
    "type": "insert",
    "rootId": "desktop-ui",
    "entry": {
      "id": "example-weather-ui",
      "packageId": "example.weather",
      "config": { "units": "metric" }
    }
  }
]
```

Configuration keys must be declared by the manifest's existing
`configuration` schema. Dependencies continue to use the manifest's existing
`dependencies` array.

## Bundle ABI

The Client entry is a prebuilt classic script. It must register one CommonJS-
style module factory while it is being loaded:

```js
window.__MakaModuleLoader__.load({
  id: 'example.weather',
  factory(require) {
    const React = require('react');
    return {
      apply(ctx, config) {
        return ctx.slots.register({ name: 'root' }, ({ children }) =>
          React.createElement('section', { 'data-units': config.units }, children),
        );
      },
    };
  },
});
```

The Runtime supplies `react`, `react/jsx-runtime`,
`@maka/ui/client-plugin-runtime`, `@maka/ui/client-plugin`, and composed package
dependencies to `require`. A package dependency must be declared in the
manifest. The bundle must not contain dynamic imports or depend on Node globals.
The full private `@maka/ui` product barrel is deliberately not available.

The Client `apply` function receives:

- the typed native and recursive Slot registrar;
- `ctx.effect(setup)` for lifecycle-owned effects;
- `ctx.style(css)` for lifecycle-owned Renderer CSS;
- immutable entry identity and generation metadata.

The backward-compatible `root` Slot wraps Maka's complete product surface. New
plugins should prefer the narrowest native Slot that fits their contribution.

## Typed recursive Slots

The Slot contract supports four composition kinds:

| Kind | Semantics |
| --- | --- |
| `single` | Lowest-priority live contribution replaces the fallback; a failed contribution yields to the next one. |
| `list` | Stable additive entries keyed by `id`, ordered by `order`, with priority shadowing per id. |
| `keyed` | One replacement cell per runtime dispatch key, such as a Tool name or Settings page id. |
| `chain` | Priority-ordered pure selectors; the first non-null match owns the render occurrence. |

Slots are `root`, `session-maybe`, or strict `session` scoped. Session Slot
components receive `sessionId`; a strict Session Slot renders its fallback when
there is no selected Session.

Maka currently exposes these deliberately small, product-native seams:

| Slot | Kind / scope | Purpose |
| --- | --- | --- |
| `shell.overlay` | list / root | Frame-wide overlay surfaces. |
| `sidebar.footer` | list / root | Additive Session-sidebar footer actions. |
| `settings.navigation` | list / root | Plugin-owned Settings navigation controls. |
| `settings.page` | keyed / root | Full plugin Settings pages dispatched by page id. |
| `conversation.header.actions` | list / session | Actions in the active conversation context header. |
| `conversation.turn.footer` | list / session | Actions below an assistant Turn. |
| `conversation.composer.toolbar` | list / session-maybe | Controls in the Composer toolbar. |
| `conversation.tool.detail` | keyed / session | Additional Tool detail keyed by Tool name; host-owned permission and sandbox status always remains visible. |

A contribution can declare child Slots in the same registration. Those children
exist only while the parent registration is live, and the parent component alone
receives the typed `renderSlot` / `renderSlotChain` authority:

```ts
declare module '@maka/ui/client-plugin' {
  interface MakaClientSlotMap {
    'weather.panel.body': {
      kind: 'list';
      scope: 'session';
      owner: { city: string };
    }
  }
}

ctx.slots.register(
  {
    name: 'shell.overlay',
    id: 'weather-panel',
    children: {
      'weather.panel.body': { kind: 'list', scope: 'session' },
    },
  },
  ({ renderSlot }) => renderSlot('weather.panel.body', { city: 'Hangzhou' }),
);
```

Removing the parent recursively removes its child declarations and occupants.
This gives plugins DSH-class nested composition freedom without making a flat,
product-wide list of every possible internal React location into a permanent ABI.

## Public UI SDK

`@maka/ui/client-plugin` is the supported Client Plugin UI surface. It exports:

- Slot contracts, runtime props, outlets, and Session scope types;
- stable Astryx layout, navigation, form, feedback, and text primitives;
- Client Plugin context types.

It does not export Maka product internals. Trusted plugins may still use DOM APIs
or ship their own React components, but private Maka imports are not compatibility
guaranteed and are not supplied by the module loader.

## Lifecycle and rollback

The Runtime Host projects a content-addressed snapshot of the active
`desktop-ui` composition. Desktop retrieves each bundle in bounded pages,
verifies its digest, and serves it through an opaque per-connection URL. The
Renderer then:

1. loads all immutable bundle factories;
2. stages every plugin and its owned effects;
3. commits the complete candidate graph;
4. atomically swaps the root wrappers and complete typed Slot graph;
5. disposes the previous graph in reverse order.

If loading, dependency resolution, `apply`, or effect setup fails, the
candidate is disposed and the last committed UI remains active. Host restart,
package reload, uninstall, and recovery therefore converge through the same
Store and composition lifecycle.

## Deferred

- typed Host-to-Client RPC, streams, and product events;
- plugin management UI and SDK build tooling;
- untrusted Renderer sandboxing or native permission escalation.

## Failure-path verification

Each root contribution has its own render error boundary. A failed root yields to its children,
so other roots and the application remain mounted; a new activation may try the contribution again.
Generation collection preserves directories owned by live packages across reconciliation.

After building Runtime, Runtime Host, UI, and Desktop main, run
`node apps/desktop/scripts/client-plugin-p1-smoke.mjs` for an isolated Electron test. It installs a
temporary Host+Client package and exercises the actual preload routing, IPC handlers, bundle serving,
Client Runtime, Session Remote override, pull stream, late effect disposal, throwing root,
reconciliation, and shutdown with a non-cooperative RPC. It uses a temporary profile and removes it
on exit; it is a test fixture, not a bundled example plugin.
