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

# Dependency patches

Root installation applies these exact-version patches with `patch-package --error-on-fail`. Product bundles use the pinned dependencies.

## `zod@4.6.7`

Recursive schemas can retain their last parse context and input graph, and exceptional exits can leave entries on the allocation stack. The patch keeps memoization local to a parse and restores allocation state in `finally`, preserving cycles, aliases and reentrant parsing.

When updating the dependency, verify its behavior before replacing or removing the patch. Keep the patched package version and the root lockfile synchronized.

## `pele@1.13.0`

The synchronous `render()` API works without a DOM, but the package's shared declarations also reference browser-only `HTMLElement` and `Node` types. The declaration-only patch resolves those types from `globalThis` when available, and to `never` otherwise. It does not add DOM globals, change runtime code, or relax the UI's library checks. Recheck native and browser type compatibility when upgrading Pele.
