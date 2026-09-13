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

# Usage settings feature

Extracts `Settings → Usage` out of the legacy renderer zone into a feature slice
(issue #4425), following the #3439 reference boundary (`ports / services-context /
ui`).

## Why

The renderer-architecture ratchet (#4088, R1 of #3439) freezes the legacy
AppShell closure: no new file may enter it and no legacy file's dependency count
may grow. `settings/usage-settings-page.tsx` is a frozen closure file, so
net-new Usage functionality — the editable pricing tab from #2015 / PR #4164,
which #2015 requires to live inside the Usage tabs — cannot be added there.
Moving the surface into `features/usage/` (exempt from closure debt) unblocks it
and shrinks legacy debt (`usage-settings-page.tsx` drops from ~14 dependencies
to a thin wrapper).

## Boundary

- `ports.ts` — `UsageServices`: `loadUsageStats(range)` and
  `updateUsageSettings(patch)`. Both narrow — the feature consumes only
  `UsageSettings`/`UsageStats`, never the whole `AppSettings`.
- `services-context.tsx` — `UsageFeatureScope`, the persistent state owner
  (single tagged `{ range, value }` snapshot, reload ticket, unmount isolation,
  Host/generation invalidation, load-failure toast), plus `useUsageServices()`
  and `useUsageStats(range)`.
- `ui/usage-settings-view.tsx` — the surface (overview + tabs + per-tab panels).
  A disposable view: it unmounts on a section change and reads the snapshot from
  the scope via `useUsageStats`, so leaving/returning re-displays the last
  snapshot immediately (stale-while-revalidate) instead of blanking.
- `ui/usage-stats-table.tsx`, `ui/metric-card.tsx`, `controller/*` — feature-owned
  presentational + framework helpers (external-only deps).

## Wiring (one deviation from the composition-feature pattern, forced by the ratchet)

Unlike the composition-wired features, `settings-surface.tsx` is itself a frozen
legacy closure file, so it cannot import the feature or a `platform/` adapter, and
usage stats are scoped to the *settings-selected* Runtime Host (a settings concept
the app-global composition root does not have). So there is **no `platform/desktop`
adapter / no composition registration — a transitional seam.** `settings-surface.tsx`
builds a host-bound `loadUsageStats` (via its existing `window.maka.settings.usageStats`
call) plus an `updateUsageSettings` that projects the app-settings update down to
`UsageSettings`, bundles them as `UsageServices`, and mounts the legacy shim
(`settings/usage-settings-page.tsx`) at two levels: `UsageScopeMount` (hosting
`UsageFeatureScope`) is placed *above the loading/error gate*, so the snapshot
survives a Skeleton/Banner state or a section change; the disposable
`UsageSettingsPage` view is rendered in the section content slot and reads the scope
via context. The scope takes a `host:epoch` `targetKey` as a **prop** (not a React
`key`): on a change it clears the snapshot and fences the in-flight load *in place*,
so a Host change never remounts the rest of the Settings surface. The Host-change
handler also calls the scope's imperative `fenceTarget()` *synchronously* (alongside
the other Host-scoped resources), rejecting an in-flight old-Host load before React
re-renders the new target. When #4425's composition step lands, only this mounting
seam moves to `composition/desktop-feature-services.tsx` + a stateless
`platform/desktop` adapter — the scope stays feature-owned.

Copy is **not** a deviation: the view imports `getUsageSettingsCopy` +
`UsageSettingsCopy` from `locales/settings-usage-copy.ts` directly. A feature import
of a validated copy catalog is closure-exempt (the ratchet's `isValidatedCopyCatalog`),
the same way workbar / goals / task-entry / session-navigation import their
`locales/*` copy. Only the legacy error helper (`describeError`) is injected by the
shim, since `settings-error-copy` is not a copy catalog.

## Follow-up

- Add a `SettingsSurface` integration test for the mount seam this PR moves.
  `usage-settings-view.test.ts` mounts `UsageFeatureScope` + `UsageSettingsView`
  directly and drives `fenceTarget()` / `targetKey` by hand; it does not load
  `settings-surface.tsx`, so the surface's fence call sites
  (`commitSelectedRuntimeHostProfile`, the generation-change handler) and the
  `usageTargetKey` derivation are not exercised end-to-end. Those three lifecycle
  obligations are exactly what a stale head had regressed with every test green, so
  a surface-level test guarding them is the real coverage; it is deferred to keep
  this extraction PR contained.
- Add the editable pricing tab (#2015 / PR #4164) as a feature-internal tab,
  replacing the read-only pricing tab preserved here.
- De-duplicate the controllers. `controller/action-guard.ts` and
  `controller/optimistic-settings-draft.ts` are feature-local copies of the legacy
  `settings/` helpers (which keep ~9 consumers and their own tests). They are
  covered here only indirectly via `usage-settings-view.test.ts`, not by the
  legacy controller tests. Extracting the pure cores to `src/shared/` (the ratchet
  treats `shared/` as external) with a thin React shell on each side is the real
  fix, but it touches the legacy originals and their consumers, so it is left as a
  focused follow-up rather than widening this extraction PR.
