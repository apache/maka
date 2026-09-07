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

# Overlays feature

This slice owns the shell's overlay surfaces: the keyboard help, the Command
Palette, the Search modal with its transcript scroll target, and the Settings
modal with what it was asked to show. The global shortcuts that open them live
here too.

## Ownership

- `OverlaysRoot` is the only production owner of `useOverlaysController`. It
  hands the shell frame the overlays through a render prop, so `AppShell`
  calls no overlay hook.
- `platform/desktop/create-overlays-services.ts` is the only adapter from the
  Desktop bridge and browser environment into this feature (thread search,
  the remembered Settings section, settling focus before Settings opens), and
  Desktop feature-services composition is its only production importer.
- The keyboard help, the Command Palette rows, and the Search modal render
  from this slice and read the controller directly. The Settings modal stays
  with the legacy settings code; `app-shell-overlays.tsx` reads what to show
  through `OverlaysConsumer` and mounts it.
- The palette's command list stays a shell concern: the shell builds the rows
  from its own actions and passes them to `CommandPalette`.

## Model

`model/settings-surface.ts` is the Settings surface as data: every opener is
an intent, `openSettingsSurface` applies it, and the section an intent lands
on is what the adapter persists. `model/search-scroll-target.ts` records the
turn a Search result asked the transcript to scroll to and marks it handled
once.
