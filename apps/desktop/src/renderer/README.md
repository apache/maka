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
| `AppShell` | `useSystemUiLocale` | `systemUiLocale` | `resolveUiLocale`, whose result reaches `LocaleProvider`, `ErrorBoundary` and `AppShellContent` | legacy `use-system-ui-locale.ts` | read the OS locale and its changes | locale | — |
| `AppShellContent` | `useActiveExecutionBoundary` | `activeExecutionBoundary` | Composer permission control and unreadable notice; the palette's permission-mode command; the Session Collaboration dialog gate; the health notice's picker gate; reloaded by the Composer submission owner and Conversation lifecycle | Conversation | read and reload the owner Session's execution boundary | cross-region command | — |
| `AppShellContent` | `useAppShellBootstrapSubscriptions` | lifecycle handlers and startup | `ShellLifecycleSubscriptions` (Session, connection, Host-profile and settings refreshes, window commands); the startup Session and E2E-fixture refresh; ⌘, and ⌘N | legacy `app-shell-effects.ts` | startup refreshes, the global shortcuts and the mounted flag; returns the handlers `ShellLifecycleSubscriptions` subscribes with the injected `ShellLifecycleSources`; no bridge access | application lifecycle | — |
| `AppShellContent` | `useAppShellHostEffects` | titlebar modal sync | the native window controls, dimmed through `titlebar-modal-sync.ts` | legacy `app-shell-effects.ts` | observe top-layer modals; the `data-os` platform tag is applied by `ShellLifecycleSources` | layout | — |
| `AppShellContent` | `useAppShellNavRefSync` | `navSelectionRef` | ownership checks of async results (Composer claim, surface-owner checks) | legacy `app-shell-effects.ts` | mirror the navigation selection into a ref | navigation | — |
| `AppShellContent` | `useAppShellPersistenceEffects` | theme and navigation persistence | `<html>` theme class and palette; stored navigation | legacy `app-shell-effects.ts` | apply the theme preference and palette; persist the navigation state | layout | — |
| `AppShellContent` | `useAppShellProjectContext` | project context | titlebar project name, path and open-folder gate; Workbar project id and aliases; Module Hub and command-palette client-path access; composer mentions project path; the default-Host refresh in the lifecycle handlers | legacy `use-project-context.ts` | read the owner Session's project (path, Git state, current project, capabilities) and, with no Session, the default Host's, and re-read it on change; no writes: project mutations and the open-folder commands belong to Task Entry | application lifecycle | — |
| `AppShellContent` | `useAppShellSessionWorkspace` | Session workspace | every region's requested, published and owner Session; transcript flags; the queue surface and named Composer edits; the Session UI reads store | legacy `use-app-shell-session-workspace.ts` over the Session catalog and Conversation | Session selection, the catalog controller, list refresh and row patches, message reads and refresh | navigation | — |
| `AppShellContent` | `useLayoutEffect` | `openSessionInChatRef` publication | every caller of `openSessionInChat`: turn footer, transcript lineage, linked-Session and revision links, Composer submission, Workbar, Module Hub, command palette, Settings overlays, turn-request approval, agent graph, titlebar parent link | AppShell | publish the current open-Session command into a ref | cross-region command | — |
| `AppShellContent` | `useSessionNavigationReads` | rail reads | transcript revision navigation, titlebar parent and `sidebarCollapsed`, frame `data-sidebar-state` and `--maka-sidenav-width` | Session Navigation | revision navigation, the active parent Session and the rail layout; writes the compact flag into `sessionRailLayoutStore` | navigation | — |
| `AppShellContent` | `useSessionSettingIntent` | selected-Session setting overlay | Composer model, thinking and mode controls; the palette's permission-mode command; new-task settings for creation; Session teardown | Session Settings | an equality-selected overlay read, the new-task settings and setting commands | cross-region command | — |
| `AppShellContent` | `useShellAppearance` | appearance settings | theme, palette, user label, Workbar toggle position, locale update gate; `appearanceHydrated` for the previous-shutdown notice | legacy `use-shell-appearance.ts` | read client and Host appearance settings and E2E state, hydrate the locale, apply theme, palette and font sizes, and expose local setters | layout | — |
| `AppShellContent` | `useShellChatModel` | Composer model selection | Composer model and executor pickers; the transcript's health notice; the staging vision gate; the readiness and new-task submission model; the first-send Session activation, which adopts the submitted executor catalog; Workbar model choices | Conversation | derive the model, thinking and executor selection and set the new-task choice | cross-region command | — |
| `AppShellContent` | `useShellConnections` | `newTaskConnections` | new-task model choices; transcript and onboarding connections and refresh; executor connection count | legacy `use-shell-connections.ts` | the new-task target's connection snapshot and refresh, falling back to the default Host or onboarding snapshot | application lifecycle | — |
| `AppShellContent` | `useShellConnections` | `defaultHostConnections` | `OnboardingConnectionSeed`; the new-task fallback; the refresh when Settings closes; the connection-event fan-out | legacy `use-shell-connections.ts` | the default Host's connection snapshot and refresh | application lifecycle | — |
| `AppShellContent` | `useShellConnections` | `sessionHostConnections` | owner Session model choices and readiness; transcript connections and refresh; the WorkHub snapshot | legacy `use-shell-connections.ts` | the owner Session Host's connection snapshot and refresh | application lifecycle | — |
| `AppShellContent` | `useShellMemoryPill` | memory indicator | the transcript's session-context memory indicator; refreshed by the lifecycle handlers and when Settings closes | legacy `use-shell-memory-pill.ts` | read and refresh the owner Session's memory state, or the default Host's without a Session | layout | — |
| `AppShellContent` | `useStableActions` | `createAppShellE2eFixtureActions` | the startup E2E-fixture refresh | legacy `app-shell-e2e-fixture.ts` over `application/contracts/use-stable-actions.ts` | apply test fixtures across Session selection and refresh, navigation, rail, Workbar, Settings, search and appearance | cross-region command | — |
| `AppShellContent` | `useState` | `petCompletionNonce` | custom pet companion | AppShell | a counter `ConversationLifecycle`'s `onTurnCompleted` bumps when the active Turn completes | cross-region command | — |
| `AppShellContent` | `useState` | `navigationState` | navigation sections; stored navigation | AppShell | the selected section and each hub's module | navigation | — |
| `AppShellContent` | `useState` | `workHubActive` | WorkHub or Session surface; Workbar workspace; the rail entry; the Session-Host connection snapshot; the titlebar identity | AppShell | whether the WorkHub surface is shown; enablement is the WorkHub enablement authority's | navigation | — |
| `AppShellContent` | `useToast` | `toastApi` | toasts and confirm dialogs of every legacy action | `@maka/ui` `ToastProvider` (Astryx) | show toasts and confirmations | cross-region command | — |
<!-- retained-root-hooks:end -->

### Transitional feature exports outside Conversation

Conversation keeps its own table of transitional capabilities in its README.
Outside it, the public exports the root takes that are not plain assembly
components (providers, roots, hosts and overlays mounted through JSX) are the
following. Exports only tests or Storybook read live in each feature's
`testing.ts`, not its public entry. A feature cannot depend on another, so a
projection one feature makes into another's region is composed here.

| Feature | Export | Root consumer | Kind | Stays because / Removal |
| --- | --- | --- | --- | --- |
| overlays | `OverlaysConsumer` | `app-shell-overlays.tsx` (Settings modal, palette command list) | render-prop projection of overlay state | stays: root composition of the legacy Settings surface and the palette command list, which a feature cannot import; it moves when the Settings surface migrates, outside R2 |
| diagnostics | `ManualDiagnosticReportConsumer` | command palette options in `app-shell.tsx` | render-prop manual report command | stays: cross-region command (the diagnostics owner's manual report, handed to the shell-built palette options) |
| task-entry | `TaskEntryWorkspacePickerConsumer` | Composer region in `app-shell.tsx` | render-prop workspace picker | stays: cross-region projection into the Composer |
| session-collaboration | `GuestTurnRequests` | Composer region in `app-shell.tsx` | render-prop guest composer projection; discards a settled request's draft through the named Composer edit | stays: cross-region projection into the Composer |
| module-hub | `ModuleHubSkillCatalogRevisionBoundary` | Composer mentions provider | render-prop skill catalog revision | stays: cross-region projection into the Composer |
| module-hub | `ModuleHubScheduledTasksBoundary` | Session rail (`SessionNavigationProvider`) | render-prop scheduled tasks | stays: cross-region projection into navigation |
| module-hub | `createModuleHubCommandPort` | command palette; project selection | command port | stays: cross-region command |
| session-navigation | `createSessionOpenCommand` | open-Session command | command factory | stays: cross-region command |
| session-navigation | `sessionRailLayoutStore` | rail collapse handle; E2E fixture | layout store | stays: layout |
| session-navigation | `useSessionNavigationReads` | see the retained-root table | read hook | stays: navigation |
| session-settings | `useSessionSettingIntent` | see the retained-root table | read hook and commands | stays: cross-region command |

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
