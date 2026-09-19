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

- `ports.ts` — `UsageServices`: `loadUsageStats(range, query)`, revision-checked
  `loadUsageActivity(input)`, and `updateUsageSettings(patch)`. The feature consumes only
  `UsageSettings`/`UsageStats`, never the whole `AppSettings`.
- `pricing-ports.ts` + `pricing-services-context.tsx` — the two Host-backed
  Pricing capabilities: load one complete effective snapshot and apply one CAS
  mutation against the settings-selected Host.
- `controller/pricing-controller.ts` — disposable Pricing authority, conflict,
  mutation execution, and Host-generation fencing. An open editor/reset dialog
  pins its viewed CAS snapshot; a list refresh cannot advance that write base or
  its catalog/duplicate validation. A Host change or view remount recovers only
  the scope-owned draft, reloads authority, and requires explicit review of the
  new Host's price before the next save. Recovery errors and Retry stay inside
  the editor. Review reclassifies Add/Edit against the new Host without changing
  rate input. A save retains its submitted draft identity, so its result only
  closes that draft; input typed while saving remains open for a later submit.
  If reconciliation was temporarily unavailable, it retains that same attempt
  and compares its exact intent with the next successful snapshot via the shared
  pure reconciliation rules in `@maka/runtime-host/protocol`, without replaying it.
  Each attempt also belongs to its dialog generation: cancellation or a different
  model key detaches the dialog while authority reconciliation continues. A late
  result cannot reopen a cancelled dialog or carry its conflict into another edit.
- `services-context.tsx` — `UsageFeatureScope`, the persistent state owner
  (single complete snapshot with range/query labels, screen/page request tickets,
  fixed filter time bounds, Host invalidation, and visible stale/capacity failures), plus `useUsageServices()`
  and `useUsageStats(range)`. It also keeps the Pricing editor's input (mode,
  raw rate text, and cache-section state) through `usePricingEditorDraft()`, so
  Settings' Host-keyed content and loading gate cannot discard the user's work.
  Pricing snapshots and in-flight operations never persist in this scope.
- `pricing-view-model.ts` — validates raw decimal/scientific rate text at the
  submission boundary, preserving partial input through remounts. Invalid and
  negative rates remain visible for correction; blank cache prices are omitted
  and an explicit zero remains zero. Astryx `TextInput` reports every keystroke;
  `NumberInput`'s private, blur-committed pending text cannot satisfy this lifetime.
- `ui/usage-settings-view.tsx` — the surface (overview + tabs + per-tab panels).
  A disposable view: it unmounts on a section change and reads the snapshot from
  the scope via `useUsageStats`, so leaving/returning re-displays the last
  snapshot immediately (stale-while-revalidate) instead of blanking.
- `ui/usage-stats-table.tsx`, `ui/metric-card.tsx`, `controller/*` — feature-owned
  presentational + framework helpers (external-only deps).

## Wiring

Usage stats remain a transitional exception because `settings-surface.tsx` is a frozen
legacy closure file, so it cannot import the feature or a `platform/` adapter, and
usage stats are scoped to the *settings-selected* Runtime Host (a settings concept
the app-global composition root does not have). `settings-surface.tsx`
builds a host-bound `loadUsageStats` (via its existing `window.maka.settings.usageStats`
call) plus an `updateUsageSettings` that projects the app-settings update down to
`UsageSettings`, bundles them as `UsageServices`, and mounts the legacy shim
(`settings/usage-settings-page.tsx`) at two levels: `UsageScopeMount` (hosting
`UsageFeatureScope`) is placed *above the loading/error gate*, so the snapshot
survives a Skeleton/Banner state or a section change; the disposable
`UsageSettingsPage` view is rendered in the section content slot and reads the scope
via context. The scope takes a `host:epoch` `targetKey` as a **prop** (not a React
`key`): on a change it clears the snapshot and fences the in-flight load *in place*.
The scope survives even when Settings replaces its Host-keyed page content. The Host-change
handler also calls the scope's imperative `fenceTarget()` *synchronously* (alongside
the other Host-scoped resources), rejecting an in-flight old-Host load before React
re-renders the new target. That same fence is exposed to the Pricing controller as
an `isCurrent` witness, so an old-Host mutation result cannot land in the event-to-
render gap. Pricing itself is already composition-wired through
`platform/desktop/create-usage-pricing-services.ts` and
`composition/desktop-feature-services.tsx`; only the selected Host is threaded
from the settings surface. When #4425's remaining composition step lands, only
the Usage-stats mounting seam moves to composition plus a stateless Desktop
adapter; the scope stays feature-owned.

Copy is **not** a deviation: the view imports `getUsageSettingsCopy` +
`UsageSettingsCopy` from `locales/settings-usage-copy.ts` directly. A feature import
of a validated copy catalog is closure-exempt (the ratchet's `isValidatedCopyCatalog`),
the same way workbar / goals / task-entry / session-navigation import their
`locales/*` copy. Only the legacy error helper (`describeError`) is injected by the
shim, since `settings-error-copy` is not a copy catalog.

## Follow-up

- The `UsagePricingHostSwitch` Settings story now exercises a real Host lifecycle
  event before input blur, page unmount, profile selection, recovered draft, and
  save against the replacement Host's CAS base. `usage-settings-view.test.ts` still drives the
  stats scope's fence and target key directly; broader stats integration coverage
  remains a follow-up.
- De-duplicate the controllers. `controller/action-guard.ts` and
  `controller/optimistic-settings-draft.ts` are feature-local copies of the legacy
  `settings/` helpers (which keep ~9 consumers and their own tests). They are
  covered here only indirectly via `usage-settings-view.test.ts`, not by the
  legacy controller tests. Extracting the pure cores to `src/shared/` (the ratchet
  treats `shared/` as external) with a thin React shell on each side is the real
  fix, but it touches the legacy originals and their consumers, so it is left as a
  focused follow-up rather than widening this extraction PR.

## Consistency

The Settings adapter installs the Storage screen as one unit and requests activity
continuation only on demand. Filter changes reload the entire screen while keeping
its resolved time bounds. A failed load retains the old complete screen with its
original labels; revision changes disable continuation until Refresh. Capacity
failures stay typed across IPC/preload and do not enter the generic error/retry
path. Successful installation resets table pagination without remounting the
search input. See [the implementation contract](../../../../../../docs/architecture/usage-screen-revision-consistency.md).
