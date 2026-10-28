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

# Services and explicit model tools

A JavaScript Host entry exports `activate(configuration)`. For each declared
service export it returns `{ contract, service: ["exportedObject"] }`. The exported
object maps method names to handlers `(input, observation, context)`. Declare
`query`, `mutation` or `subscription` and exact input/output/resource schemas in the
service contract. Validate unknown responses before consuming them.

`RequestContext.invoke` sends a request over the current entry's captured imports:

```ts
const result = await context.invoke({
  operation: 'call', import: 'echo', provider: 0, method: 'echo', input: 'hello',
});
if (typeof result !== 'string') throw Error('Invalid Echo result');
```

The import and its provider index are declared bindings. A JSON target, identity or
path supplies no capability. Request-local resource attachments map outgoing slots
to existing incoming slot names. They are not arbitrary bytes or reusable handles.
Retaining `context` after the handler ends does not keep the request alive.

Subscriptions publish with `await context.invoke({ operation: 'emit', value })`;
await each emission to honor backpressure. Mutations supply the original
`operationId` and inspect the returned `OperationReply`, including cleanup.
[State and authority](state-and-authority.md) covers unknown results and recovery.

To expose a service method to Maka's Agent, explicitly configure `agent.tools` with
its `name`, `description`, `import`, `method`, `result` (`json` or an available
specialized projection) and `confirmation` (`required` or `preapproved`). Bind that
import to the service and provide the corresponding Host NativeGrant. Confirmation
is an additional user decision, never a substitute for method authorization.
Use the actual generated `AgentConfiguration` and `AgentServiceTool` types to check
fields. A declaration does not add a global tool or confer filesystem/process access.

The same Host service can be consumed by its package's UI or by another UI plugin.
Declare the contract in `application.ui.imports`, bind its providers in the UI
instance, and call `context.services[importName][providerIndex]`. These service
calls use the actual UI consumer's session and original mutation receipt. The
trusted module also retains the full client `context.host`; import bindings do
not introduce a separate UI permission boundary. See [Shared NSH UI plugins](ui-plugins.md).

Skills use the ordinary Library contract, actual registered tool names and independent
`search`, `load` and `prepare` grants. `agent.skillLibrary` explicitly selects input
preparation. Prepared inputs and receipts remain in the original message record;
queued execution must not reread mutable inputs. A general custom input-preparation
hook is not currently a public application ABI: implement the required capability
and its Agent integration explicitly instead of assuming a global registry.
