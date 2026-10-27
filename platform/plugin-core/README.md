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

# maka-plugin-core

[简体中文](README.zh-CN.md)

Defines package declarations, contracts and a single deployment source containing Host, UI and composition instances. `plan` validates the entire graph and stable identities; `runtime` owns Host registrations, UI consumer bindings, admitted work and retirement. Enabled UI instances are projected from that same source and run in the client's shared NSH runtime. Host Runtime does not execute UI code.

Packages declare `host`, `ui` and/or `composition`. Each source node selects one through `usePackage`; installing a package alone does not enable it. UI entries name an NSH module, service imports and root, command, panel, settings or tool-renderer contributions. UI consumer registration resolves those imports.

`Input.ui` is the deployment's only product root selection: `{path, id}` identifies an enabled UI instance and one of its `UiContribution::Root` contributions. `None` selects headless operation. A `Template` defines a reusable instance graph and does not own the product root. Any UI package can provide the complete product UI, including replacing the default Maka Workbench.

The kernel has no Agent policy or native layout vocabulary. A binding selects an export that satisfies an import; the receiving Host still checks permission when a call arrives.

Composition expansion, forwarding and dependency validation use iterative traversal with exact cycle checks. Repeated package templates remain valid when finite overrides terminate expansion; binding cardinality follows the declared import contract. Instance identities retain every nonzero source UUID.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
