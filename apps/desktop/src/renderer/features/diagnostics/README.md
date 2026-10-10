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

# Diagnostics feature

This slice owns the renderer's use of Desktop diagnostics.

## Ownership

- `DiagnosticReportToastProvider` is the renderer's toast layer. It offers the
  Desktop diagnostic report on error toasts and copies it through the injected
  `copyToastReport` service. It reads the action's words from the shared shell
  catalog, where they stay beside the Error Boundary and command palette copy
  that use the same ones.
- `PreviousMainProcessInterruptionNotice` alone reads whether the previous main
  process ended without finishing its shutdown, once the shell's appearance has
  hydrated, and shows that notice at most once per renderer. A read that
  resolves after its effect was replaced (for example by a locale change) is
  dropped; the replacement read shows the notice in the current locale.
- `ManualDiagnosticReportConsumer` hands the manual report command to its two
  callers: About, and AppShell, which passes it to the command palette in its
  command options. Each caller keeps its own target, toasts and pending state;
  the command takes only the optional task or Host profile target.
- `RendererCrashReportConsumer` hands the crash report command to the Error
  Boundary, or nothing outside Desktop composition (Storybook, renderer tests).
  The boundary then copies its own bounded browser report, so the crash surface
  never depends on a provider being mounted.
- `platform/desktop/create-diagnostics-services.ts` is the only adapter from the
  Desktop bridge into this feature, and Desktop feature-services composition is
  its only production importer. Each service fixes its report surface (`toast`,
  `manual`, `renderer_crash`) and forwards only the fields its caller supplied.

No renderer file outside that adapter calls the diagnostics bridge. AppShell
holds no notice state and receives only the manual report command.
