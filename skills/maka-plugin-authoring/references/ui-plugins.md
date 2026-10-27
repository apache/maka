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

# NSH applications and UI contributions

Terminal and desktop mount the root UI selected by the connected deployment. Maka's bundled workbench is an ordinary UI package, `maka.workbench`, selected through the same mechanism as a custom application. Installed UI code runs in the shared NSH client VM and can use its full NSH and `maka/host` capabilities.

A UI entry names a bundled JavaScript module, its configuration schema and its contributions:

```json
{
  "application": {
    "ui": {
      "module": "ui.js",
      "configuration": { "type": "object", "additionalProperties": false },
      "contributions": {
        "root": { "kind": "root" },
        "counter": { "kind": "panel", "title": { "fallback": "Counter" } },
        "openCounter": { "kind": "command", "title": { "fallback": "Open counter" } }
      }
    }
  }
}
```

## Select the application root

A composition selects one contribution as the client entrypoint:

```json
{
  "ui": { "path": ["example"], "id": "root" }
}
```

`path` identifies an enabled `usePackage: "ui"` instance; `id` identifies its declared `root` contribution. That root renders the complete NSH application and owns its navigation, composition and presentation of other contributions. Selecting a custom root displays that application rather than wrapping it in the Maka workbench. Root selection is explicit; a missing or failing selection is reported instead of substituting Maka's UI.

The default product selects `{ "path": ["workbench-ui"], "id": "root" }`, whose package is `maka.workbench`. A package can export a root together with panels, commands, settings or tool renderers. Installing additional UI contributions does not change the selected root; update the composition's `ui` selector when changing the application itself.

## Implement contributions

The module exports synchronous `activate(context): UiExports`. It returns an object keyed by the same local IDs as the declaration, with matching kinds:

```tsx
import { signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';

export function activate(context) {
  const count = signal(0);
  function Counter() {
    return <View><Text>{count()}</Text>
      <Button onPress={() => count.set(count() + 1)}><Text>Increment</Text></Button>
    </View>;
  }
  return {
    root: { kind: 'root', render: Counter },
    counter: { kind: 'panel', render: Counter },
    openCounter: { kind: 'command', run() { context.openPanel('counter'); } },
  };
}
```

Root `render` receives `{ context, runtime, restored }`. The shared `runtime` exposes contributions, rendering and command invocation; the root chooses how to present them. Optional `prepareReload()` persists owned drafts and returns JSON before a shared VM reload; its JSON is supplied as `restored` on the next root mount. A root that needs no reload handoff can just provide `render`, as the local-state counter does.

Contributions are `root`, `panel`, `command`, `settings` or `tool_renderer`. Panels and settings expose `render(props)`; commands expose `run({ sessionId })`. A tool renderer declares an exact `presentation` key and receives the already-read `arguments` or `result` value plus tool metadata. The workbench owns the tool card's status, disclosure and original-source access.

`UiContext` supplies the instance, package, source, configuration, full client `host`, bound `services`, operation recovery, `locale()`, `asset(path)` and `openPanel(id, input?)`. Use `asset(path)` for resources relative to the declared UI module: with `module: "ui/index.js"`, `asset("logo.png")` reads the package's `ui/logo.png`. The runtime supplies the package namespace, so two packages can both contain a `logo.png`. Use `UiText`'s `fallback` and `translations` for contribution labels, and `context.locale()` for rendered content. Read `references/sdk/workbench.ts` for exact props.

## Calling the plugin's Host services

A package may include a Host service and UI that consumes it. Declare the service contract in `application.ui.imports`, then select the actual provider in the UI instance's composition `bindings`. Imports may also select services from other packages. For example, an `echo` import with cardinality `one` is bound to a Host instance's `Echo` export:

```json
{
  "kind": "instance",
  "path": ["echo-backend"],
  "export": "Echo"
}
```

Place that target in `instances.counter.bindings.echo`. The source contains separate `echo-backend` and `counter` instances with `usePackage: "host"` and `usePackage: "ui"`; both can select the same immutable package. The import's `contract` is the same declared service contract as the provider's export. Read the Host service example for the contract shape rather than duplicating a different interface.

The UI uses its declared import name and provider index:

```ts
const echo = context.services.echo[0];
const message = await echo.query('echo', 'Hello');
```

Each service supports `query`, `subscribe`, `mutation` and `beginMutation` according to the bound contract. Calls use a Host session captured for the actual UI consumer and its selected providers. This gives the calls the correct instance identity and keeps mutations tied to their original receipt. It is not a plugin sandbox: trusted code still has the full `context.host` client and the shared NSH environment.

`mutation` returns `{ operationId, reply }`, including the original `OperationReply`. Use `beginMutation` when progress or cancellation is needed; consume its `next()` events through `finished`. `context.operations.pending()` lists unresolved operations for this UI instance. Recover an existing ID with `context.operations.recover(id)` rather than issuing the mutation again after a disconnect. `abandon(id)` is for an attempt that has not prepared; it does not undo a confirmed effect. See [State and authority](state-and-authority.md).

The client loads the selected root and lazily loads other modules when their contributions are used and calls `activate` under that instance's NSH owner. Register subscriptions and timers with `nsh.cleanup`. Closing a panel unmounts that view; disabling, removing or changing the instance's package, configuration or service bindings refreshes its activation and captured services. An unrelated deployment revision does not reload the plugin. Keep I/O asynchronous and avoid rereading or reparsing an entire conversation during rendering.

`assets/starter/ui.tsx` is the complete root/counter example. Build it with the CLI's NSH bundler. Common NSH components work across terminal pixels, Unicode and desktop; platform-native components need the corresponding backend implementation.
