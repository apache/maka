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

# API sources

In the bundled skill, `references/sdk/` contains the SDK sources from the same build. In a checkout, read `packages/plugin-sdk/src/`.

| Need | File within the SDK |
| --- | --- |
| `HostService`, `RequestContext` and public exports | `index.ts` |
| `UiContext`, `UiExports` and contribution props | `workbench.ts` |
| Package, composition, catalog and wire types | `generated/runtime.ts` |
| Public service contracts | `contracts.ts`, or `contracts/<name>.ts` in bundled resources |
| Native configuration schemas | `configurations.ts` |
| Native Host implementation definitions | `native.ts` |

`maka application schema` emits the executable's catalog. In a checkout, `npm --workspace @maka-agent/plugin-sdk run schema:generate` regenerates the SDK through `tools/schema`; `schema:check` checks for drift. Rust declarations are the source of package and management wire types. The NSH component API is supplied by NSH, independently of those Host service contracts.

The bundled contract map is split into one resource per contract. Its values come from the generated SDK; checkout `contracts.ts` remains the source of truth.
