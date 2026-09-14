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

# Client Plugin Runtime PR1 contract

PR1 makes a trusted Renderer bundle part of the same package, immutable
generation, and composition authority as a Host plugin. It intentionally ships
one typed `root` Slot. The wider Slot catalog and Host-to-Client RPC/events are
separate follow-up changes.

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

PR1 supplies `react`, `react/jsx-runtime`, `@maka/ui/client-plugin-runtime`, and
composed package dependencies to `require`. A package dependency must be
declared in the manifest. The bundle must not contain dynamic imports or depend
on Node globals. A curated public component SDK belongs to PR2; PR1 does not
expose the full `@maka/ui` barrel to plugins.

The Client `apply` function receives:

- the typed `root` Slot registrar;
- `ctx.effect(setup)` for lifecycle-owned effects;
- `ctx.style(css)` for lifecycle-owned Renderer CSS;
- immutable entry identity and generation metadata.

The root Slot wraps Maka's complete product surface. More specific and
recursively extensible Slots, including provider-aware UI insertion points,
belong to PR2.

## Lifecycle and rollback

The Runtime Host projects a content-addressed snapshot of the active
`desktop-ui` composition. Desktop retrieves each bundle in bounded pages,
verifies its digest, and serves it through an opaque per-connection URL. The
Renderer then:

1. loads all immutable bundle factories;
2. stages every plugin and its owned effects;
3. commits the complete candidate graph;
4. swaps the root Slot once;
5. disposes the previous graph in reverse order.

If loading, dependency resolution, `apply`, or effect setup fails, the
candidate is disposed and the last committed UI remains active. Host restart,
package reload, uninstall, and recovery therefore converge through the same
Store and composition lifecycle.

## Deferred from PR1

- the full typed Slot catalog and recursive sub-Slots;
- typed Host-to-Client RPC, streams, and product events;
- plugin management UI and SDK build tooling;
- untrusted Renderer sandboxing or native permission escalation.
