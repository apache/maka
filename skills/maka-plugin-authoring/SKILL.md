---
name: maka-plugin-authoring
description: Create, extend or debug Maka plugins, including Host services, complete NSH applications, UI contributions, and deployment bindings.
license: Apache-2.0
---
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

# Maka plugin authoring

Start from the plugin's declaration and the contract its consumer needs. A package declares Host and UI entries or a composition; deployment instances select `usePackage: host`, `ui` or `composition`. The source's `ui: { path, id }` selects its root UI contribution. Host entries declare imports and exports. Native factory registration makes an implementation available. Host grants determine whether a call is allowed.

In a checkout, authored plugins live under `plugins/<family>/<plugin>/package.ts`. Rust implementation crates sit beside the plugin or in a shared family directory. Product selection and wiring belong to `products/maka/bundle`; compiled Host factories are selected in `products/maka/native`. Keep business behavior in the owning plugin.

For a new package, follow [Quickstart](references/quickstart.md). It covers a single-plugin checkout build and the Echo service and NSH root/counter starter. For an existing plugin, inspect its entry, contracts and captured imports before editing. Preserve instance UUIDs when updating an installation: those identities own saved state.

Read the guide relevant to the change:

- [Host services and Agent tools](references/tools-and-input.md): handlers, scoped calls and tool selection.
- [Runtime UI authoring](references/runtime-ui.md): directly manage the connected source and enable UI contributions.
- [Shared NSH UI plugins](references/ui-plugins.md): root selection, contributions, module activation, assets and cleanup.
- [State and authority](references/state-and-authority.md): data ownership, mutation receipts and cancellation.
- [Native Rust](references/native-rust.md): definitions, registration and resource lifetime.
- [Models and execution](references/models-and-execution.md): Agent/provider integration.
- [Testing and shipping](references/testing-and-shipping.md): package checks, installation and actual runtime tests.
- [Product source examples](references/product-sources.md): current Host contracts, business package examples and product wiring, with a generated resource index.
- [API sources](references/api-map.md): exact types and schemas for this build.

Use the SDK root exports and the runtime's `maka application schema` output. Rust declarations generate SDK contracts; hand-editing generated files creates drift. Host JavaScript entries use service imports and request-local resources. UI modules are trusted code in the shared NSH client VM, using its existing client capabilities; do not invent a second UI permission or execution model.

When this skill is loaded through Maka, use the reference and catalog revision returned by discovery. Read a resource with `resource: { path: "references/quickstart.md" }` and pass returned `next` objects back unchanged. Use the tool name from current metadata. The packaged `references/sdk/` directory contains this build's SDK sources; in a checkout they live under `packages/plugin-sdk/src/`.

Verify the changed behavior in its declared runtime. A package check establishes contract compatibility; UI input, service effects and recovery need checks at their actual owners.
