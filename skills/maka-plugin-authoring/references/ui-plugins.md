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

# Shared NSH UI plugins

Maka's terminal and desktop run one NSH workbench. An installed UI plugin is trusted code in that workbench's VM and can use its NSH and `maka/host` capabilities. Declare ordinary NSH components rather than a terminal-specific scene protocol.

A UI entry names a bundled JavaScript module, its configuration schema and its contributions:

```json
{
  "application": {
    "ui": {
      "module": "ui.js",
      "configuration": { "type": "object", "additionalProperties": false },
      "contributions": {
        "counter": { "kind": "panel", "title": { "fallback": "Counter" } },
        "openCounter": { "kind": "command", "title": { "fallback": "Open counter" } }
      }
    }
  }
}
```

The module exports synchronous `activate(context): UiExports`. It returns an object keyed by the same local IDs as the declaration, with matching kinds:

```tsx
import { signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';

export function activate(context) {
  const count = signal(0);
  return {
    counter: {
      kind: 'panel',
      render() {
        return <View><Text>{count()}</Text>
          <Button onPress={() => count.set(count() + 1)}><Text>Increment</Text></Button>
        </View>;
      },
    },
    openCounter: { kind: 'command', run() { context.openPanel('counter'); } },
  };
}
```

Contributions are `panel`, `command`, `settings` or `tool_renderer`. Panels and settings expose `render(props)`; commands expose `run({ sessionId })`. A tool renderer declares an exact `presentation` key and receives the already-read `arguments` or `result` value plus tool metadata. The workbench owns the tool card's status, disclosure and original-source access.

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

The workbench loads a module when its contribution is used and calls `activate` under that instance's NSH owner. Register subscriptions and timers with `nsh.cleanup`. Closing a panel unmounts that view; disabling, removing or changing the instance's package, configuration or service bindings refreshes its activation and captured services. An unrelated deployment revision does not reload the plugin. Keep I/O asynchronous and avoid rereading or reparsing an entire conversation during rendering.

`assets/starter/ui.tsx` is the complete counter example. Build it with the CLI's NSH bundler. Common NSH components work across terminal pixels, Unicode and desktop; platform-native components need the corresponding backend implementation.
