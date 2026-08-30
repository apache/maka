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

`main.tsx` → `app.tsx` → `AppShell` (`app-shell.tsx`). `index.html` is the Vite HTML shell. `main.tsx` prefetches the onboarding snapshot before mounting React so the normal-path first commit paints the real surface (if the prefetch times out it mounts with `null` and a fail-soft loading state); `app.tsx` wraps `AppShell` in `ToastProvider` + `ErrorBoundary`.

`styles.css` is the **only** bundled style entry: it imports Astryx, fonts, `maka-tokens.css`, `reference-shell.css`, and every `styles/*.css`. It contains only top-level orchestration; real selector rules go in `styles/*.css`. One contract-pinned exception: `index.html` carries an inline `.maka-preload` skeleton with hardcoded colors (no CSS variables — `maka-tokens.css` hasn't loaded yet) so there's no blank window during the CSS + JS load gap; `createRoot` replaces it on mount.

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
  implements narrow inward-facing ports rather than exporting the whole bridge;
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
rejected. Legacy import allowlists may only shrink relative to the base branch. Same-count
dependency replacement is allowed only when it moves ownership behind a shell,
feature public, or application public/contract boundary.

`ownership[].targetZone` is migration-roadmap metadata in this foundation: its
shape and legacy path coverage are validated, but it does not claim to prove
that a capability has reached its final owner. The directory dependency rules
remain executable. A later owner contract can add verifiable owner paths and
public entries once each mixed legacy capability has been split precisely.

Exact Hook names remain visible in the generated ledger. A legitimate Hook
replacement must use a one-time `hookTransitions` entry: the new call count has
to be paid one-for-one by removal of the named old Hook in the same debt file,
the total Hook budget may not grow, and historical transitions cannot be reused.
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

`settings/` holds the settings pages and the `SettingsModal` shell — one page per `SettingsSection` (defined in `@maka/core`); the models/providers page is `ProvidersPanel`. Plus the `provider-*` files and the shared `settings-rows` / `settings-skeleton` / `settings-surface` helpers.

## Styles & tokens

| File | Role |
|---|---|
| `astryx-theme/makaTheme.ts` | Source for the Astryx type scale, neutral remaps, and theme-level component overrides. |
| `astryx-theme/maka.css` | Generated Astryx theme imported by `styles.css`; regenerate it from `makaTheme.ts`, never edit it directly. |
| `maka-tokens.css` | The main source of product CSS tokens (color / shadow / typography aliases / radius / spacing / motion / z / layout), plus a large recipe section at the tail. Transitional: tokens and recipes coexist in one file. |
| `reference-shell.css` | A target-layout shell rebuild, hand-authored from a reference-implementation extract (its header comment documents the provenance). **Transitional** — meant to be folded back into the token/style system and removed. |
| `styles/*.css` | Per-surface hand-written recipes (e.g. `chat-*`, `sidebar`, `composer`, `palette`, `settings/*`, `module-pages/*`). |

Token authoring rule: custom CSS variables go in `maka-tokens.css`. New component-local vars should carry `/* local: ... */` (existing ones don't all have it yet). No new hardcoded color / radius / z-index.

Note the `--foreground-N` split: the wash stops (`-2/-3/-5/-8/-10`) are surface fills for backgrounds and borders, **not** text. The 3-tier semantic aliases (`--foreground` / `--foreground-secondary` / `--muted-foreground`) are the text-color vocabulary. They are separate concerns — don't collapse the wash stops into the text aliases.

## New code: primitive first, CSS last

1. Reach for an Astryx-backed `@maka/ui` primitive first.
2. Only if no primitive carries it, write CSS in the matching `styles/<surface>.css`, following `docs/frontend-css-governance.md` (layer rules, the unlayered override list, the `!important` audit, the dead-CSS allowlist).
3. Don't add a token without registering it in `maka-tokens.css`.

## Convergence direction (transitional surfaces)

Acknowledged transitional states — not TODOs; track work in issues/PRs.

- Existing hand-written `styles/*.css` recipes and internal-DOM overrides on Astryx-backed `@maka/ui` primitives are acknowledged transitional states, not precedent for new work. New styling uses published props, tokens, or stable `themeProps` extension points; track concrete retirement work in GitHub issues and PRs.
- `reference-shell.css`: end state is folded into the token/style system and the file removed.
- `maka-tokens.css` mixing tokens + recipes: end state is tokens-only here, recipes living on primitives / `styles/`.

## Contracts & guardrails

- Product design intent: `DESIGN.md`.
- CSS cascade / layer / `!important` / dead-CSS / token rules: `docs/frontend-css-governance.md`.
- Component state, ARIA, token, and copy behavior is owned by source and focused contract tests.
- Where prose disagrees with code or behavioral tests, code and tests are the source of truth. CSS conventions are checked by review and rendered-surface verification. Build/test entry points are the npm scripts in the root `package.json` (see the top-level `README.md`).
