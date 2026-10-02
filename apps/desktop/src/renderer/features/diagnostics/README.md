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

This slice owns the renderer root's use of Desktop diagnostics.

## Ownership

- `DiagnosticReportToastProvider` is the renderer's toast layer. It offers the
  Desktop diagnostic report on error toasts and copies it through the injected
  `copyToastReport` service. AppShell supplies only the action's labels, which
  stay in the shared shell catalog beside the Error Boundary and command
  palette copy that use the same words.
- `PreviousMainProcessInterruptionNotice` alone reads whether the previous main
  process ended without finishing its shutdown, once the shell's appearance has
  hydrated, and shows that notice at most once per renderer. A read that
  resolves after its effect was replaced (for example by a locale change) is
  dropped; the replacement read shows the notice in the current locale.
- `platform/desktop/create-diagnostics-services.ts` is the only adapter from the
  Desktop bridge into this feature, and Desktop feature-services composition is
  its only production importer. The adapter forwards only the fields an error
  toast carried, as the `toast` report surface.

AppShell calls no diagnostics bridge method and holds no notice state.

## Not in this slice

The Error Boundary's crash report, the command palette's manual report
(`app-shell-command-actions.ts`) and About's manual report still call the
Desktop bridge from legacy renderer files. Each can move onto this feature's
services when its owner is next changed; none of them runs in AppShell's render
body.
