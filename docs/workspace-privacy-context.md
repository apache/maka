---
doc_id: workspace-privacy-context
title: "Workspace privacy context"
language: en
source_language: en
implementation_status: current
document_status: current
translation_status: source-only
last_verified: 2026-09-04
owners:
  - maka-backend
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

# Workspace privacy context

`WorkspacePrivacyContext` is the shared contract for privacy-sensitive operations. Its current shape is deliberately small:

```ts
export interface WorkspacePrivacyContext {
  incognitoActive: boolean;
}
```

## Authority

The Runtime Host owns the effective workspace privacy state as runtime policy. Renderers may request a change and display the current value, but a renderer-provided value is never proof of the effective state.

The current authority path is:

- `apps/desktop/src/renderer/settings/general-settings-page.tsx` requests settings changes.
- The effective state is the Runtime Host runtime policy: `packages/core/src/runtime-policy.ts` declares the readonly `privacy.incognitoActive` field and defaults it to `false`; patches are validated by the policy codec's `privacy patch` record rule.
- Desktop surfaces resolve the effective state from the policy via `queryRuntimePolicy()` (for example `apps/desktop/src/main/runtime-host-search-ipc-main.ts`), and core-boundary consumers validate the projected context through `validateWorkspacePrivacyContext()` (`packages/core/src/incognito.ts`) before reading any field.

One documented exception: the run-ended notification gate (`apps/desktop/src/main/notifications-ipc-main.ts`) still reads `privacy.incognitoActive` from the local settings store, and privacy patches never reach that store (`apps/desktop/src/shared/settings-ownership.ts` excludes `privacy` from the local patch), so the gate keeps seeing the stale or default value after incognito is enabled and can raise a notification carrying the session title and reply preview. Migrating this gate to the policy authority is a named follow-up; until it lands, this gate is the one documented deviation from the rule above.

`validateWorkspacePrivacyContext()` rejects malformed input; it never converts missing or invalid data to `false`. Boundaries that cannot resolve a valid authoritative context must fail closed.

## Consumer rule

`incognitoActive: false` only means that incognito mode did not block the operation. It is not general permission to read, write, search, capture, or transmit data. Every consumer must still apply its own settings, permission, and retention rules.

When `incognitoActive` is true, each privacy-sensitive consumer defines a fail-closed result at its existing main-process boundary. The Runtime Host composition, the desktop main-process consumers, and their focused tests own the current inventory. Do not duplicate that inventory here, add another incognito flag, copy the state into a parallel store, or let a renderer self-attest.

## Contract changes

Adding fields, changing scope, or changing default semantics is a cross-cutting contract change. Update the core type and validator, main-process authority path, every consumer, tests, and this document together.
