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

# Host plugins and shell interfaces

Maka's terminal and desktop shells run the same workbench, which connects to the business Host. The default product contains one Host composition, its exact packages and explicit publication/native grants. It does not install an editable SDK UI deployment, a separate management Host, or a foreground authoring worker.

Use the workbench's Plugins page to inspect and change the selected Host composition. Preserve the observed source revision and every unrelated instance UUID. Installation stores checked immutable package bytes; adding an instance and selecting its bindings are separate operations. Read the original mutation receipt after a disconnect instead of submitting the mutation again. A committed source establishes desired state; it does not prove activation or visible success.

For an inactive Host, the generic `maka application check`, `commit`, `read` and `serve` commands operate on explicit sources and deployments. `maka application compose` emits `host.json`, `endpoints.json`, `native-grants.json` and resolved installation identities for the bundled business services. `update-defaults` previews selected package replacements without changing the source's identities, settings or grants. See the CLI `--help` and [Testing and shipping](testing-and-shipping.md).

## Custom UI request consumers

The native `ui.submit`/`ui.result` service and its SDK contracts remain available to independently authored clients. These tools require a client that implements the `watch`, `claim` and `complete` lifecycle for that request queue and explicitly supplies its management authority. Neither built-in shell currently supplies that consumer. A queued request alone does not mean a UI edit occurred, and retrying a mutation produces a new operation.

When working with such a custom client, discover its current tool names and inspect its original source and declarations. Follow the typed `UiAuthoringCommand` inputs in the SDK. Queries such as `instances`, `readDocument` and `readPackage` refer to that client's selected deployment; they do not confer access to another Root or the business Host. Observe the same request ID until its original outcome is known. A custom client owns execution, durable receipt recovery and its actual presentation checks.

For standalone SDK scene components, see [UI components](terminal-apps.md). Those contracts and examples are independent of Maka's built-in shell interfaces.
