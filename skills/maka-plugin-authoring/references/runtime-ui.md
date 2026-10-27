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

# Change the connected workbench

The connected Host owns one deployment source containing Host, UI and composition instances. Both shells discover the enabled UI instances from that source. Installing immutable package bytes only makes the package available; inserting and enabling a UI instance publishes its contributions.

Use current tool metadata and generated input types. The default product provides direct management tools:

- `UIRead` reads the deployment; `UIReadCatalog` lists enabled UI contributions.
- `UIInstances`, `UIReadDocument` and `UIReadPackage` inspect the observed source.
- `UIInstallSource` and `UIInstallUrl` install immutable packages.
- `UIEditComposition` inserts, removes or updates instances; `UISetEnabled` enables or disables them.
- `UIReadSettings`, `UIConfigure`, `UIBindingCandidates` and `UIPackageSettings` inspect and edit configuration and Host bindings.
- `UIReplaceSource` replaces a complete source when that is the appropriate edit.

Read the current source first, retain its `expectedRevision`, and preserve unrelated instance UUIDs. `usePackage` explicitly selects `host`, `ui` or `composition`. A UI entry can declare service `imports`, and the UI instance's `bindings` select Host providers in this same source. Pure UI plugins need no imports or placeholder Host service. Package and instance configuration still follow their declared schema.

For authored UI, compile TSX with `maka application build-ui --entry ENTRY --output DIRECTORY`, stage its module and assets in the package, and install those exact bytes. Return to the source after installation before inserting an instance, because installation changes its revision. The workbench observes committed source changes and loads the enabled contribution when needed. A successful commit establishes desired state; verify the actual command, panel, settings page or tool output afterward.

These tools operate on the same source as the client. A mutation's original receipt is the evidence for its result. After a disconnect recover that receipt instead of issuing the mutation again.

See [Shared NSH UI plugins](ui-plugins.md) for the module contract and lifecycle, and [State and authority](state-and-authority.md) for mutation settlement.
