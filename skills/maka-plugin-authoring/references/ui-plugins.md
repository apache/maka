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

The module exports synchronous `activate(context): UiActivation`. Its `exports` map uses the declaration's local IDs and matching kinds. State shared by the instance's contributions belongs to this activation:

```tsx
import { signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import type { UiContext } from '@maka-agent/plugin-sdk';

export function activate(context: UiContext) {
  const restored = context.restored;
  if (restored !== null && typeof restored !== 'number') throw Error('Invalid counter state');
  const count = signal(restored ?? 0);
  function Counter() {
    return <View><Text>{count()}</Text>
      <Button onPress={() => count.set(count() + 1)}><Text>Increment</Text></Button>
    </View>;
  }
  return {
    exports: {
      root: { kind: 'root', render: Counter },
      counter: { kind: 'panel', render: Counter },
      openCounter: { kind: 'command', run() { context.openPanel('counter'); } },
    },
    async prepareReload() { return count(); },
  };
}
```

Root `render(props: UiRootProps)` receives `{ context, runtime }`. The shared `runtime` exposes contribution discovery, rendering and command invocation; the root chooses their layout and navigation. Panels and settings receive `{ context, runtime, sessionId, input }`. A tool renderer declares an exact `presentation` key and receives the already-read `arguments` or `result` value plus tool metadata; the workbench owns the tool card's status, disclosure and original-source access.

`UiContext` supplies the instance, package, source, configuration, bound `application` client and `services`, full trusted client `host`, operation recovery, shared `runtime`, instance `restored` state, `locale()`, `asset(path)` and local `openPanel(id, input?)`. Use `asset(path)` for resources relative to the declared UI module: with `module: "ui/index.js"`, `asset("logo.png")` reads `ui/logo.png` in this package. Use `UiText`'s `fallback` and `translations` for contribution labels, and `context.locale()` for rendered content. Read `references/sdk/workbench.ts` for exact props.

## Embed another plugin's view

An embedded contribution declares `{ "kind": "view", "contract": "example.counter" }` and returns the same kind and contract from its implementation. Define the input contract once in a module shared by the provider and consumer:

```ts
import { defineUiViewContract } from '@maka-agent/plugin-sdk';
export const counterView = defineUiViewContract<{ label: string }>('example.counter');
```

The provider exports `{ kind: 'view', contract: counterView.id, render({ input }) { ... } }`. The consumer selects its deployment target and passes the typed input:

```tsx
const target = { path: ['counter-ui'], id: 'counter' };
return context.runtime.renderView(target, counterView, { label: 'Items' });
```

`runtime.view(target, contract)` resolves a contribution without rendering it. Both methods reject a missing target, the wrong contribution kind or a different contract. `UiTarget` uses the same `{ path, id }` shape as root selection; keep replaceable targets in the consuming package's configuration. The contract name is checked at runtime, while TypeScript checks the input shape. Inputs can carry reactive accessors and callbacks between trusted UI modules; they are not Host wire messages.

The SDK's `workbench-views.ts`, `composer-view.ts` and `workspace-view.ts` define the current workbench contracts. Maka composes conversation navigation, sessions, previews, settings and the composer through ordinary contributions. `assets/composer-ui/` supplies a standalone replacement using the composer contract and resident session controller. The contract also exposes typed completion and checklist sources. The sample needs no Host imports or bindings. Its README explains building it and selecting its target.

For a panel in another instance, call `context.runtime.openPanel({ path, id }, input)`. The selected root registers its presentation with `runtime.handlePanels(handler)`.

## Commands

Commands expose `run({ sessionId, argument? })` and may provide synchronous `enabled(context)`. Returning `false` from `run` declines the invocation. Use `runtime.commandEnabled` for availability and `runtime.invoke` to execute; invocation rechecks availability after loading the provider.

The declaration can include localized `description` and `hint`, `shortcut`, `order`, `trigger` and `takesArgument` alongside its title. `takesArgument: true` requires a trigger. A command consumer such as the composer uses this metadata for discovery, ordering and argument entry; the provider owns its execution behavior.

## Preserve activation state on reload

Every active instance may provide `prepareReload(): Promise<unknown>` on its returned activation. The client pauses input and awaits all active instances before replacing the shared VM. Persist owned drafts and return JSON for transient UI state. On reactivation that JSON is available as `context.restored` when the instance UUID identity and package ID match, including a new revision or configuration of that package. Other instances receive `null`; restoration is independent of the selected root.

If any preparation rejects before replacement, the current UI and bindings remain and input resumes. A new activation failure is reported after replacement. Await durable saves during preparation; NSH cleanup releases subscriptions and resources when the old owner is destroyed.

UI reload reuses the Client, operation journal and Host. Accepted Host work continues with its original operations and receipts. Recover those operations after reload instead of replaying mutations. View unmounting only removes a presentation; activation-owned controllers and drafts can remain alive for its next mount.

## Calling the plugin's Host services

A package may include a Host service and UI that consumes it. Declare the service contract in `application.ui.imports`, then select the actual provider in the UI instance's composition `bindings`. Imports may also select services from other packages. For example, an `echo` import with cardinality `one` is bound to a Host instance's `Echo` export:

```json
{
  "bindings": {
    "echo": [{ "kind": "instance", "path": ["echo-backend"], "export": "Echo" }]
  }
}
```

Place these bindings on `instances.counter`. Every import maps to an array of targets, including cardinality `one`. The source contains separate `echo-backend` and `counter` instances with `usePackage: "host"` and `usePackage: "ui"`; both can select the same immutable package. The import's `contract` is the same declared service contract as the provider's export. Read the Host service example for the contract shape.

The UI uses its declared import name and provider index:

```ts
const echo = context.services.echo[0];
const message = await echo.query('echo', 'Hello');
```

Each service supports `query`, `subscribe`, `mutation` and `beginMutation` according to the bound contract. `context.services[importName][providerIndex]` selects one provider, including imports with cardinality `many`. `context.application` provides the `UiHost` application client using this instance's declared service bindings. Both retain the actual UI consumer's identity, selected providers and original mutation receipts. Trusted code also has the full `context.host` client and `maka/host` capabilities in the shared NSH environment; import bindings establish business routing rather than a sandbox.

Bundled business UI creates its internal adapter once with `createHost(context.application)`, passes that Host explicitly to controllers and installs a local `HostProvider` for each package's views. External packages use public SDK methods or typed view inputs directly. These adapters share the native Client, journal and original receipts; they create no replacement mutation owner.

`mutation` returns `{ operationId, reply }`, including the original `OperationReply`. Use `beginMutation` when progress or cancellation is needed; consume its `next()` events through `finished`. `context.operations.pending()` lists unresolved operations for this UI instance. Recover an existing ID with `context.operations.recover(id)` rather than issuing the mutation again after a disconnect. `abandon(id)` is for an attempt that has not prepared; it does not undo a confirmed effect. See [State and authority](state-and-authority.md).

The client loads the selected root and lazily loads other modules when their contributions are used, calling `activate` under that instance's NSH owner. Register subscriptions and timers with `nsh.cleanup`. Disabling, removing or changing an active instance's package, configuration or service bindings prepares the active instances and refreshes the shared VM. An unrelated deployment revision preserves existing activations. Keep I/O asynchronous and avoid rereading or reparsing an entire conversation during rendering.

`assets/starter/ui.tsx` is the complete root/counter example. Build it with the CLI's NSH bundler. Common NSH components work across terminal pixels, Unicode and desktop; platform-native components need the corresponding backend implementation.
