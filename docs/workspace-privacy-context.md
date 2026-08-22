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

The main process owns the effective workspace privacy state. Renderers may request a change and display the current value, but a renderer-provided value is never proof of the effective state.

The current authority path is:

- `apps/desktop/src/renderer/settings/general-settings-page.tsx` requests settings changes.
- `apps/desktop/src/main/main.ts` resolves the effective state through `getWorkspacePrivacyContext()`.
- Main-process consumers receive that resolved context rather than trusting renderer input.

`defaultWorkspacePrivacyContext()` returns `{ incognitoActive: false }` for explicit initialization. `validateWorkspacePrivacyContext()` rejects malformed input; it never converts missing or invalid data to `false`. Boundaries that cannot resolve a valid authoritative context must fail closed.

## Consumer rule

`incognitoActive: false` only means that incognito mode did not block the operation. It is not general permission to read, write, search, capture, or transmit data. Every consumer must still apply its own settings, permission, and retention rules.

When `incognitoActive` is true, each privacy-sensitive consumer defines a fail-closed result at its existing main-process boundary. The composition in `apps/desktop/src/main/main.ts` and focused consumer tests own the current inventory. Do not duplicate that inventory here, add another incognito flag, copy the state into a parallel store, or let a renderer self-attest.

## Contract changes

Adding fields, changing scope, or changing default semantics is a cross-cutting contract change. Update the core type and validator, main-process authority path, every consumer, tests, and this document together.
