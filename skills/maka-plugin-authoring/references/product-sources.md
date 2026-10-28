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

# Product source examples

The bundled skill includes selected TypeScript source from the same build as its SDK. Read `references/source-index.md` for exact resource paths and sizes, then request only needed files. In a checkout, read the original paths below.

| Task | Start here |
| --- | --- |
| Declare a Host service and explicit imports | `plugins/application/gateway/package.ts`, `plugins/shared/package.ts` |
| Inspect package and management contracts | `references/sdk/contracts/`, `references/sdk/generated/runtime.ts` |
| Wire Agent/WorkHub instances and grants | `products/maka/bundle/src/composition.ts` |
| Build a root application or UI contribution | `assets/starter/ui.tsx`, `references/sdk/workbench.ts` |
| Replace the composer using the resident session controller | `assets/composer-ui/README.md`, `assets/composer-ui/index.tsx`, `references/sdk/composer-view.ts` |
| Inspect the shared business UI input contracts | `references/sdk/workbench-views.ts`, `references/sdk/workspace-view.ts` |

In packaged resources, prepend `references/source/` to checkout paths. Relative imports retain their checkout spelling; imports into `packages/plugin-sdk/src/` are available under `references/sdk/`. This is reference source, not a standalone build tree. The starter and composer assets supply standalone examples.

Read a package declaration before its implementation. Inspect the current Host through its deployment manager before editing it; installed sources may differ from bundled examples. UI contributions use the same package and deployment source as Host services, and both shells mount the selected root through NSH. The bundled Maka workbench is itself an ordinary UI package.

The build uses an explicit source allowlist, excluding implementation directories, tests, local files and build output. Extend the allowlist when another complete example materially helps authoring.
