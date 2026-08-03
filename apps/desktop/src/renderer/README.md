# Renderer (`apps/desktop/src/renderer`)

The Electron renderer process: the React UI body of the Maka desktop app. React + Vite, consuming Astryx through `@maka/ui` primitives.

For the main/preload/renderer split and the IPC contract, see `apps/desktop/README.md`. This file covers the renderer interior.

## Entry

`main.tsx` → `app.tsx` → `AppShell` (`app-shell.tsx`). `index.html` is the Vite HTML shell. `main.tsx` prefetches the onboarding snapshot before mounting React so the normal-path first commit paints the real surface (if the prefetch times out it mounts with `null` and a fail-soft loading state); `app.tsx` wraps `AppShell` in `ToastProvider` + `ErrorBoundary`.

`styles.css` is the **only** bundled style entry: it imports Astryx, fonts, `maka-tokens.css`, `reference-shell.css`, and every `styles/*.css`. It contains only top-level orchestration; real selector rules go in `styles/*.css`. One contract-pinned exception: `index.html` carries an inline `.maka-preload` skeleton with hardcoded colors (no CSS variables — `maka-tokens.css` hasn't loaded yet) so there's no blank window during the CSS + JS load gap; `createRoot` replaces it on mount.

## AppShell + the action modules

`app-shell.tsx` is the shell component: owns session state, wires the `@maka/ui` panels (SessionListPanel, ChatView, Composer — ChatView renders the tool stream via `ToolTrow`), and lazy-mounts SessionWorkbar, which owns the task ledger, browser, and generated files. It is supported by a set of `app-shell-*` modules, each a narrow slice of shell logic split by one concern (e.g. `app-shell-session-events.ts`, `app-shell-chat-actions.ts`, `app-shell-plan-actions.ts`, `app-shell-effects.ts`, `app-shell-stop-action.ts`, `app-shell-overlays.tsx`). Most follow `app-shell-<scope>-<action>.ts(x)`; a few single-word slices like `app-shell-effects.ts` or `app-shell-copy.ts` drop the action segment. Keep a slice to one concern; if it grows, split along the same seam.

`settings/` holds the settings pages and the `SettingsModal` shell — one page per `SettingsSection` (defined in `@maka/core`); the models/providers page is `ProvidersPanel`. Plus the `provider-*` files and the shared `settings-rows` / `settings-skeleton` / `settings-surface` helpers.

## Styles & tokens

| File | Role |
|---|---|
| `maka-tokens.css` | The main source of CSS tokens (color / shadow / typography / radius / spacing / motion / z / layout), plus a large recipe section at the tail (base styles, utilities, component recipes, animations). Transitional: tokens and recipes coexist in one file. |
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

- Hand-written `styles/*.css` recipes + overrides on `@maka/ui` primitives: end state is structure carried by primitives, renderer CSS left only with layout primitives can't cover. Track concrete retirement work in GitHub issues and PRs.
- `reference-shell.css`: end state is folded into the token/style system and the file removed.
- `maka-tokens.css` mixing tokens + recipes: end state is tokens-only here, recipes living on primitives / `styles/`.

## Contracts & guardrails

- Product design intent: `DESIGN.md`.
- CSS cascade / layer / `!important` / dead-CSS / token rules: `docs/frontend-css-governance.md`. The dead-CSS check runs from the repo root via `check:release` (`scripts/check-dead-css.mjs --check`); its baseline is `scripts/check-dead-css-baseline.json`.
- Component state, ARIA, token, and copy behavior is owned by source and focused contract tests.
- Where prose disagrees with the code or contract tests, the code and tests are the source of truth. Key guardrail tests live in `apps/desktop/src/main/__tests__/` (style-layer-cascade, important-audit, typography / spacing / radius / state-token / foreground-tier governance). Build/test entry points are the npm scripts in the root `package.json` (see the top-level `README.md`).
