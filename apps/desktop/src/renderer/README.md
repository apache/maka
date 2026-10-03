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

# Renderer (`apps/desktop/src/renderer`)

The Electron renderer process: the React UI body of the Maka desktop app. React + Vite, consuming Astryx through `@maka/ui` primitives.

For the main/preload/renderer split and the IPC contract, see `apps/desktop/README.md`. This file covers the renderer interior.

## Entry

`main.tsx` → `app.tsx` → `AppShell` (`app-shell.tsx`). `index.html` is the Vite HTML shell. `main.tsx` mounts React immediately — the `.maka-preload` launch overlay covers the load gap and stays until a surface commits `data-maka-content-ready`; `app.tsx` wraps `AppShell` in `ToastProvider` + `ErrorBoundary`.

`styles.css` is the **only** bundled style entry: it imports Astryx, fonts, `maka-tokens.css`, and every `styles/*.css`. It contains only top-level orchestration; real selector rules go in `styles/*.css`. One contract-pinned exception: `index.html` carries an inline `.maka-preload` launch overlay with hardcoded colors (no CSS variables — `maka-tokens.css` hasn't loaded yet) so there's no blank window during the CSS + JS load gap; it retires once a surface commits `data-maka-content-ready`.

## Renderer ownership boundary

`app-shell.tsx`, `app-shell-*`, and `use-app-shell-*` are a **frozen legacy
boundary**, not a pattern for new renderer code. They temporarily retain
ownership that predates the composition-root migration. Do not add another
file to this family or move new state, effects, subscriptions, bridge calls, or
feature view-model construction into it. Its recorded debt may only decrease as
each capability moves to its target owner.

The target dependency direction is:

```text
bootstrap -> composition -> shell + application contracts + feature public entries
platform/desktop -> injected feature/application ports
features -> own internals + shared contracts/core/UI
application -> shared contracts + injected ports
```

- `shell/` owns only the fixed frame, regions, and mount/visibility policy. It
  has no Desktop bridge access, feature implementation imports, or business
  state/effects. Direct storage, timers, fetches, and DOM/global subscriptions
  are environment ownership too and are forbidden here.
- `bootstrap/` owns one-shot startup and React mount sequencing. Apart from
  locating the DOM mount point, it owns no React state/class lifecycle,
  storage, timers, subscriptions, or network access.
- `composition/` assembles providers, adapters, and public feature hosts. It is
  wiring, not another lifecycle or browser-environment owner.
- `application/` owns explicitly shared renderer authorities. It must not
  depend on feature, shell, Desktop adapter, preload, or main-process
  implementations.
- `features/<name>/` owns one vertical capability. A feature cannot access
  `window.maka`, import another feature's internals, or depend on AppShell,
  preload, main, or `platform/desktop`. Consumers use its public `index` entry;
  `testing` is test/Storybook-only.
- `platform/desktop/` is the outer adapter zone for the preload bridge. It
  implements narrow inward-facing ports rather than exporting the whole bridge:
  where a port is a structural subset of one bridge namespace the adapter hands
  that namespace through as-is (`sessions: bridge.sessions`) instead of
  restating each method, and hand-writes the blocks that rename, guard, or
  translate;
  composition and adapters consume application public entries, not deep
  implementation modules. Adapters may own bridge and browser-environment
  access, but never React UI/hooks/class lifecycle, Electron/Node imports, or
  non-static dependency loading.

The right/bottom Workbar and the other extracted features define their detailed
state and lifecycle boundaries in their own READMEs. Cross-feature behavior
uses explicit contracts and intents, not private imports or a service locator.

### Architecture guardrail and migration ledger

`apps/desktop/scripts/check-renderer-architecture.mjs` parses renderer imports,
bridge aliases, browser-environment access, and stateful-hook ownership and
enforces the zones above, including imported/local hook aliases, React 19 state
hooks, React component class state/lifecycle, and non-static global access. It
also rejects Electron/Node imports from inward zones, deep/cross-feature
imports, `import.meta.glob` escape hatches, production use of feature testing
entries, and application contracts that re-export application implementation.
`apps/desktop/renderer-architecture.json` records the exact legacy/root debt and
maps every AppShell/root path to its intended owner. It freezes every
unclassified legacy renderer source and every non-owner Desktop source
transitively reachable from AppShell. The graph crosses explicit feature,
application, and platform owners while recording legacy renderer, shared,
preload, and other non-owner intermediaries in the debt closure. The ledger
traverses declarations for dependency resolution without treating them as
runtime debt; explicit owner nodes remain governed by their zone rules. It also
freezes the separate root-entry closure and each transitional
feature/platform import of legacy code. The AppShell-family and root-entry
files are full ratchets: dependency paths, imported bindings,
bridge/hooks/browser capabilities, action factories, and non-trivia tokens may
not grow. Their transitive support closures ratchet only architectural
capabilities and dependencies, so ordinary implementation can evolve without
token-count ledger noise. A support entry may move one way from the AppShell
closure to the root closure without resetting its budget; the reverse move is
rejected. Legacy import allowlists may only shrink relative to the base branch.
CI runs the checker as `--base <sha> --strict-base`: the ratchet re-derives the
base commit's debt from its materialized tree rather than trusting its committed
ledger, and `--strict-base` turns any failure to materialize or analyze that tree
into a hard error. A silent fallback to the committed ledger could reintroduce
the stale-ledger failure #4250 demonstrated, where a base ledger that
under-reported its own tree wedged CI. When the checker script itself differs
from the base commit, the base commit's checker is also imported to measure
both trees, and debt the base measurement rules (generation and classification)
would have flagged fails as a `base-checker cross-check:` violation, so one
change cannot loosen how debt is measured and lower both sides of the ratchet
at once. Under `--strict-base`, failure to write, import, or run an existing
base checker, a missing `generateArchitectureConfig` export, or output that
does not match the current ledger schema is a hard error. Without the flag,
these conditions are reported and the cross-check is skipped. A base commit
without a checker has no old measurement rules to run and is skipped in both
modes. The schema validation and comparison still run under the current checker;
changes to those rules remain a review concern. In particular, changes to
`validateMonotonicDebt` are not protected by the cross-check.

`featurePrivateModules` seals selected feature construction modules. They may
be consumed inside their owning feature and through its `testing.ts` seam, but
runtime exports through the public entry, intermediate re-export barrels, and
runtime imports from outside the feature fail the architecture gate. Public
type-only exports remain available. The list is monotonic against the base:
removing a protected path does not silently reopen that boundary. This guard
checks module edges, not the behavior of arbitrary wrappers; public capability
shapes and ownership still require review. Conversation uses it to keep raw
Session UI construction and whole-state inspection out of production consumers.

`rootSymbolUses` records, per feature public entry, the runtime symbols each
root zone takes from it: `appShell` (the AppShell family above),
`composition`, and `bootstrap` (`bootstrap/` plus the guarded `main.tsx` and
`app.tsx` entries). Being allowed to import an entry does not make every export
appropriate for the root. The checker attributes named and default imports,
static namespace members (including `<NS.X>` in JSX) and named re-exports, and
follows `export { x } from`, re-exported imports and `export *` through any
intermediate module until it reaches a feature public entry, so a legacy shim
cannot hide which symbol the root holds. A root namespace binding may only be
read as static members. Passing it on, destructuring or spreading it, computed
access, `import x = NS.y`, `export *` / `export * as` over an entry, and a
runtime `import()` or `require` of an entry are rejected because their symbols
cannot be attributed. Type-only imports and type positions are not recorded.
Deep feature imports stay with the zone rules. `--write` regenerates the record
and the tree must match it exactly. Against the base the record may only
shrink, with two exceptions the CLI lists as it admits them. A new root use
passes when the same change adds that binding to the entry's public surface,
measured on the materialized base tree. Bindings are compared by their
declaring module and local name, so a new alias of an export the base entry
already had is not new. A use may also move one way out of
`appShell` into `composition` or `bootstrap` when `appShell` gives it up in the
same change; a copy or the reverse move fails. Taking an export the base entry
already had fails, and so does removing the record. This is a module-graph rule:
it does not see a legacy helper that wraps a feature export and returns the
result, and it does not prove that an admitted export is narrow at runtime. Both
remain review concerns.

Dependency-path debt prices only regressive runtime edges. Type-only imports
are erased at compile time and never count. Edges into a shell, feature public,
or application public/contract boundary are the direction the migration wants,
so the AppShell family and both closures may add them freely; root entries may
not, because `main.tsx` and `app.tsx` are meant to become thin mounts, and
they may only replace an existing edge, same-count, with a bootstrap or
composition target (their closure may also replace into application or
platform).

Validated copy catalogs are admitted for every section, root entries included:
the locale policy (#2672) forces user-visible copy out of business files and
into `locales/*-copy.ts` catalogs, which necessarily adds import edges the debt
ratchet would otherwise forbid. A catalog is admitted structurally, re-verified
on every run: it must carry a `UiCatalog` marker from `@maka/core/ui-locale`,
record zero tracked hook/bridge/lifecycle/environment/action-factory
capabilities, and keep its runtime imports to bare package specifiers — never
relative or `@maka/desktop/` paths — so a catalog cannot become a dependency
tunnel. A `locales/*-copy.ts` file that fails validation is a
dedicated violation (`copy catalog validation failed: …`), never a silent fall
back to the ratchet. Admitted edges are excluded from dependency-count
ratchets, closure admission, and feature/Desktop-adapter legacy budgets;
everything else about the importing file still ratchets, and root-entry
import/token counts stay strict.

`ownership[].targetZone` is migration-roadmap metadata in this foundation: its
shape and legacy path coverage are validated, but it does not claim to prove
that a capability has reached its final owner. The directory dependency rules
remain executable. A later owner contract can add verifiable owner paths and
public entries once each mixed legacy capability has been split precisely.

Exact Hook names remain visible in the generated ledger, and no tracked Hook
call count may grow in a debt file.
The separate AppShell render-scope inventory tracks which calls still execute
above the whole renderer tree; this architecture checker governs the broader
root and transitive capability debt.

New flat renderer modules are forbidden; new code belongs in an explicit zone.
The existing `settings`, `locales`, `astryx-theme`, and
`computer-use-overlay` directories may still add scoped legacy files, but those
files cannot become newly reachable from AppShell/root or a feature/Desktop
adapter without passing the corresponding ratchet.

Run the current-tree check locally with:

```sh
npm run check:renderer-architecture
```

Before opening a PR, also verify that debt did not grow relative to main:

```sh
npm run check:renderer-architecture -- --base upstream/main
```

After a legitimate debt-reducing move, regenerate the mechanical counts and
then run the base comparison; regeneration cannot hide growth from CI:

```sh
npm run check:renderer-architecture -- --write --base upstream/main
```

`main.tsx` and `app.tsx` are permanent guarded root entries while those files
exist. Their recorded debt can fall to zero as they become thin mounts, but the
ledger entries remain so that a later PR cannot add bridge, hook,
browser-environment, dynamic-import, or legacy dependency ownership back into
them. A root entry guard may be removed only when the guarded source file is
deleted.

The production entry chain is part of the same root contract. The main process
delegates its one renderer navigation to `main-renderer-loader.ts`, which loads
only `dist-renderer/index.html`; Vite must build that document from
`src/renderer`; and the source HTML must keep a single external module entry at
`/main.tsx`. A build-time Vite attestation also inspects the final module graph,
and a post-build verifier binds the emitted HTML's sole script to that exact
entry chunk while preserving the fixed CSP and rejecting extra executable or
navigation surfaces. An HTML-transform plugin therefore cannot silently
replace or augment the canonical entry after the source check. `main.tsx`
remains under the permanent root guard. Moving any part of this chain requires
an explicit architecture change instead of routing around the ledger.

This initial guardrail is source-policy and migration metadata only. It does not
change runtime behavior, provider order, IPC/storage contracts, bootstrap,
Composer mount semantics, Session switching, or Workbar resource lifecycles.

`--report` prints the completion measures #4582 tracks for M3 and M5: the
AppShell-family bridge references and action factories from
`legacyAppShell.files`, the rows of the Conversation README's transitional
capability table, the hook-gate entries that lack a retained-root row, and the
root symbol uses per zone. It only reports. These numbers fall over several
PRs, and the existing no-growth ratchets already stop them rising. It also
lists the feature public symbols that legacy files in the AppShell closure
take, and a `--base` run prints each one a change adds there. Those files are
not a root zone and their entry edges stay free, so this is reported, never
ratcheted.

### Retained root hooks

Every hook the AppShell hook gate (`scripts/check-app-shell-hooks.mjs`) still
allows has one row per call site below. A row either names why the call stays
at the root (locale, navigation, layout, a cross-region command, or an
application lifecycle) or the R2 module that removes it, never both. The
architecture checker reads the gate's `ALLOWED` literal without running or
editing it, and fails when a gate entry has no row, when its row count differs
from the gate's call-site count, or when a row names a hook the gate no longer
lists. Where an entry has several call sites, each row's call site must name,
in backticks, an identifier of exactly one of those calls in `app-shell.tsx`
(a binding it declares or an identifier in its arguments), and no two rows may
name the same call. A change that moves a hook out of AppShell therefore edits
the gate and deletes the matching rows together. The checker validates the
table's shape and call-site binding, not the accuracy of each consumer, owner
or reason, which stays with review.

<!-- retained-root-hooks:start -->
| Component | Hook | Call site | Consumer | Owner | Allowed capability | Root reason | Removal |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `AppShell` | `useState` | `uiLocalePreference` | `LocaleProvider`; appearance settings | AppShell | the persisted locale preference and its setter | locale | — |
| `AppShell` | `useState` | `uiLocaleOverride` | `LocaleProvider`; E2E locale override | AppShell | a runtime locale override above every region | locale | — |
| `AppShell` | `useSystemUiLocale` | `systemUiLocale` | `resolveUiLocale` for `LocaleProvider` | AppShell | read the OS locale and its changes | locale | — |
| `AppShellContent` | `useActiveExecutionBoundary` | `activeExecutionBoundary` | Composer permission control; the Composer submission owner reloads it after a boundary answer | Conversation | read and reload the owner Session's execution boundary | — | M3 |
| `AppShellContent` | `useAppShellBootstrapSubscriptions` | Main change subscriptions | Session, connection, Host-profile and settings refreshers; app-window commands | legacy `app-shell-effects.ts` | startup refreshes, the global shortcuts and the handlers `ShellLifecycleSubscriptions` subscribes with the injected `ShellLifecycleSources`; no bridge access | application lifecycle | — |
| `AppShellContent` | `useAppShellHostEffects` | titlebar modal sync | titlebar | legacy `app-shell-effects.ts` | observe top-layer modals; the `data-os` platform tag is applied by `ShellLifecycleSources` | layout | — |
| `AppShellContent` | `useAppShellNavRefSync` | `navSelectionRef` | ownership checks of async results | AppShell | mirror the navigation selection into a ref | navigation | — |
| `AppShellContent` | `useAppShellPersistenceEffects` | theme and navigation persistence | `<html>` theme class and palette; stored navigation | legacy `app-shell-effects.ts` | apply the theme preference and palette; persist the navigation state | layout | — |
| `AppShellContent` | `useAppShellProjectContext` | project context | titlebar project name and path; Workbar, Module Hub and palette project inputs; the default-Host project refresh | legacy `use-project-context.ts` | read the owner Session's and the default Host's project projection; project mutations and the open-folder commands belong to Task Entry | — | M5 |
| `AppShellContent` | `useAppShellSessionUiReads` | displayed Session chrome | interaction, queue, live-turn and execution chrome; Composer props | Conversation (transitional reader) | fixed-purpose reads of the displayed and owner Session | — | M3 |
| `AppShellContent` | `useAppShellSessionWorkspace` | Session workspace | every region's requested, published and owner Session | legacy `use-app-shell-session-workspace.ts` over the Session catalog and Conversation | Session selection and the catalog controller | navigation | — |
| `AppShellContent` | `useAppShellTurnPresentation` | `deriveTurnPresentation` | `ChatView` turn footer | application contract `turn-presentation` | derive turn presentation from the transcript projection and pending turn actions | — | M3 |
| `AppShellContent` | `useEffect` | `defaultHostConnections`: onboarding connection seed | default-Host connection projection | AppShell | seed default-Host connections from the onboarding authority's read-only projection | — | M5 |
| `AppShellContent` | `useLayoutEffect` | `openSessionInChatRef` publication | turn footer, Module Hub, titlebar parent link | AppShell | publish the current open-Session command into a ref | cross-region command | — |
| `AppShellContent` | `useSessionNavigationReads` | rail reads | command palette sessions, titlebar parent, `--maka-sidenav-width` | Session Navigation | revision navigation, the active parent Session and the rail layout | navigation | — |
| `AppShellContent` | `useSessionSettingIntent` | selected-Session setting overlay | Composer model and mode controls; new-task settings for creation | Session Settings | an equality-selected overlay read, the new-task settings and setting commands | — | M3 |
| `AppShellContent` | `useShellAppearance` | appearance settings | theme, palette, user label, Workbar toggle position, locale update gate | legacy `use-shell-appearance.ts` | read and write client appearance settings | layout | — |
| `AppShellContent` | `useShellChatModel` | Composer model selection | model picker, health notice, new-chat model | Conversation (transitional) | derive model, thinking and executor selection | — | M3 |
| `AppShellContent` | `useShellConnections` | `newTaskConnections` | new-task model choices | legacy `use-shell-connections.ts` | the new-task target's connection snapshot and refresh | application lifecycle | — |
| `AppShellContent` | `useShellConnections` | `defaultHostConnections` | Settings, global commands, model setup | legacy `use-shell-connections.ts` | the default Host's connection snapshot and refresh | application lifecycle | — |
| `AppShellContent` | `useShellConnections` | `sessionHostConnections` | owner Session model choices | legacy `use-shell-connections.ts` | the owner Session Host's connection snapshot and refresh | application lifecycle | — |
| `AppShellContent` | `useShellLiveTurn` | live-turn flags | mode-change gating, model switch, pet activity | Conversation reads | derive streaming and settled flags from the owner Session snapshot | — | M3 |
| `AppShellContent` | `useShellMemoryPill` | memory pill | titlebar memory pill | legacy `use-shell-memory-pill.ts` | read and refresh the owner Session's memory state | layout | — |
| `AppShellContent` | `useShellResume` | resume offer | Composer send slot | Conversation | per-Session resume availability | — | M3 |
| `AppShellContent` | `useStableActions` | `createAppShellE2eFixtureActions` | E2E fixture command | AppShell | apply test fixtures across navigation, rail, Workbar and appearance | cross-region command | — |
| `AppShellContent` | `useState` | `petCompletionNonce` | custom pet companion | AppShell | a counter the transcript bumps when the active Turn completes | cross-region command | — |
| `AppShellContent` | `useState` | `navigationState` | navigation sections; stored navigation | AppShell | the selected section and each hub's module | navigation | — |
| `AppShellContent` | `useState` | `workHubActive` | WorkHub or Session surface | AppShell | whether the WorkHub surface is shown | navigation | — |
| `AppShellContent` | `useToast` | `toastApi` | toasts of every legacy action | Astryx toast provider | show toasts | cross-region command | — |
| `AppShellContent` | `useTurnActionRegistry` | pending turn actions | turn footer disabled mask; the Composer submission owner's Turn branch; bootstrap clears | legacy `use-turn-action-registry.ts` | pending action keys per Session | — | M3 |
<!-- retained-root-hooks:end -->

### Transitional feature exports outside Conversation

Conversation keeps its own table of transitional capabilities in its README.
Outside it, the public exports the root takes that are not plain assembly
components (providers, roots, hosts and overlays mounted through JSX) are the
following. Exports only tests or Storybook read live in each feature's
`testing.ts`, not its public entry.

| Feature | Export | Root consumer | Kind | Stays because / Removal |
| --- | --- | --- | --- | --- |
| overlays | `OverlaysConsumer` | `app-shell-overlays.tsx` (Settings modal, palette command list) | render-prop projection of overlay state | M5, with the legacy command actions |
| diagnostics | `ManualDiagnosticReportConsumer` | command palette options in `app-shell.tsx` | render-prop manual report command | M5, with the legacy command actions |
| task-entry | `TaskEntryWorkspacePickerConsumer` | Composer region in `app-shell.tsx` | render-prop workspace picker | M3 |
| session-collaboration | `GuestTurnRequests` | Composer region in `app-shell.tsx` | render-prop guest composer projection over the Composer ref | M3 |
| module-hub | `ModuleHubSkillCatalogRevisionBoundary` | Composer mentions provider | render-prop skill catalog revision | M3 |
| module-hub | `ModuleHubScheduledTasksBoundary` | Session rail (`SessionNavigationProvider`) | render-prop scheduled tasks | stays: cross-region projection into navigation |
| module-hub | `createModuleHubCommandPort` | command palette; project selection | command port | stays: cross-region command |
| session-navigation | `createSessionOpenCommand` | open-Session command | command factory | stays: cross-region command |
| session-navigation | `sessionRailLayoutStore` | rail collapse handle; E2E fixture | layout store | stays: layout |
| session-navigation | `useSessionNavigationReads` | see the retained-root table | read hook | stays: navigation |
| session-settings | `useSessionSettingIntent` | Composer model and mode controls | read hook and commands | M3 |

`settings/` holds the settings pages and the `SettingsModal` shell — one page per `SettingsSection` (defined in `@maka/core`); the models/providers page is `ProvidersPanel`. Plus the `provider-*` files and the shared `settings-rows` / `settings-skeleton` / `settings-surface` helpers.

## Styles & tokens

| File | Role |
|---|---|
| `astryx-theme/makaTheme.ts` | Source for the Astryx type scale, neutral remaps, and theme-level component overrides. |
| `astryx-theme/maka.css` | Generated Astryx theme imported by `styles.css`; regenerate it from `makaTheme.ts`, never edit it directly. |
| `maka-tokens.css` | The source of product CSS tokens (color / shadow / typography roles / radius / spacing / motion / z / layout), including the type-role table. Tokens only. |
| `styles/document.css` | Document-level defaults: box sizing, scrollbars, the html/body ground, selection, film grain, lucide stroke, global reduced motion. |
| `styles/*.css` | Per-surface hand-written recipes (e.g. `chat-*`, `sidebar`, `composer`, `palette`, `settings/*`, `module-pages/*`). |

Token authoring rule: custom CSS variables go in `maka-tokens.css`. New component-local vars should carry `/* local: ... */` (existing ones don't all have it yet). No new hardcoded color / radius / z-index.

Note the `--foreground-N` split: the wash stops (`-2/-3/-5/-8/-10`) are surface fills for backgrounds and borders, **not** text. The two semantic aliases (`--foreground` / `--muted-foreground`) are the text-color vocabulary. They are separate concerns — don't collapse the wash stops into the text aliases.

## New code: primitive first, CSS last

1. Reach for an Astryx-backed `@maka/ui` primitive first.
2. Only if no primitive carries it, write CSS in the matching `styles/<surface>.css`, following `docs/frontend-css-governance.md` (layer rules, the unlayered override list, the `!important` audit, the dead-CSS allowlist).
3. Don't add a token without registering it in `maka-tokens.css`.

## Convergence direction (transitional surfaces)

Acknowledged transitional states — not TODOs; track work in issues/PRs.

- Existing hand-written `styles/*.css` recipes and internal-DOM overrides on Astryx-backed `@maka/ui` primitives are acknowledged transitional states, not precedent for new work. New styling uses published props, tokens, or stable `themeProps` extension points; track concrete retirement work in GitHub issues and PRs.

## Contracts & guardrails

- Product design intent: `DESIGN.md`.
- CSS cascade / layer / `!important` / dead-CSS / token rules: `docs/frontend-css-governance.md`.
- Component state, ARIA, token, and copy behavior is owned by source and focused contract tests.
- Where prose disagrees with code or behavioral tests, code and tests are the source of truth. CSS conventions are checked by review and rendered-surface verification. Build/test entry points are the npm scripts in the root `package.json` (see the top-level `README.md`).
