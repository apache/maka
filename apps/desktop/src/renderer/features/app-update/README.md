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

# App Update feature

This slice owns the Desktop renderer's App Update state and user actions.

## Ownership

- `AppUpdateProvider` is the only production owner of `useAppUpdateController`.
- `useAppUpdateController` is the only renderer subscriber to update status.
- `platform/desktop/create-app-update-services.ts` is the only adapter from the
  Desktop bridge into this feature, and Desktop feature-services composition is
  its only production importer.
- Main, preload, and the updater keep their existing IPC and download
  lifecycle ownership; the shared contract lives in `src/shared/app-update.d.ts`.

The controller subscribes before reading its initial snapshot. Pushes advance
an observation revision, so neither a late initial read nor a command result
can overwrite newer status.

## Render scopes

The provider publishes two independent projections:

- About receives full status plus the guarded manual-check command.
- The sidebar footer receives only `downloaded` and versioned `error`
  reminders plus the install/retry command.

Download progress therefore has no reader when About is closed. When About is
open, only its update section reads progress. The unrelated AppShell and
Session Navigation chrome retain their existing elements and contexts.

Do not re-export the controller hook from `index.ts`, subscribe in AppShell or
Settings, or pass update state through Session Navigation props. The boundary
and provider-scope tests enforce those constraints.
