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

# Session settings

`SessionSettingsProvider` is the sole production owner of
`useSessionSettingsController`. It owns each Session's model/thinking,
permission, Plan and orchestration write intents, including optimistic overlays,
latest-intent convergence and retirement after the catalog observes a write.
Desktop operations enter through `SessionSettingsServices`; this feature never
reads `window.maka`.

## Shell boundary

`useSessionSettingIntent(sessionId)` retains the shell's existing hook name,
but is now an equality-selected read of only that Session's four overlays.
It creates a per-shell bridge, without calling the write controller. The shell
still needs these values to derive its model picker and mode controls. The hook
inventory therefore stays at one call; it does not claim that all settings
reads have left the shell.

The bridge forwards stable commands to the provider's latest committed
controller. The provider publishes after commit and reuses the shell's children
on its own updates. Writes for other Sessions do not re-render the shell or its
frame. Cleanup disconnects commands and clears the published overlays.

## Preserved behavior

- Model and thinking remain one compound write. Only a successfully committed
  model selection updates the Composer defaults.
- Model, permission and orchestration overlays retire against the owning
  Session's committed revision, not an unrelated Runtime Host catalog update.
- Bypass confirmation retains its captured Composer owner and refuses to write
  if that owner changed while the confirmation was open.
- Plan entry checks the Host's current execution. Leaving a pending proposal
  requires confirmation and abandons that exact proposal on the requested
  Session, even if navigation changes meanwhile. The Runtime leaves Plan as
  part of abandoning; orchestration is preserved.
- Failed writes retain the existing rollback and active-Session error behavior.

`index.ts` exports the owner and the shell read; `testing.ts` exposes the
controller and Plan policy to tests. `controllerOwners` enforces the production
ownership boundary.

Plan panel subscriptions/presentation, new-task drafts, the Session catalog and
the Session Collaboration dialog remain owned by their existing boundaries.
