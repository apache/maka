# @maka/ui

Shared UI layer for the Maka desktop app: React + Tailwind v4 + shadcn (base-nova) + `@base-ui/react`, bound to Maka's token system. Consumed at runtime by `apps/desktop`'s renderer; the preload bridge also imports types from it (`import type` only).

This package is the **target carrier of the frontend convergence**: hand-rolled renderer CSS recipes are being retired onto primitives exported here. When in doubt, extend a primitive rather than add CSS at the call site.

## Layer map

Four export surfaces, in the order to look:

| Surface | Role | Status |
|---|---|---|
| `src/primitives/` | One file per primitive (e.g. `accordion`, `badge`, `chip`, `dialog-header`, `input`, `page-header`, `tabs`, `textarea`, `toolbar`, `tooltip`, …). **New primitives go here.** | target layer |
| `src/ui.tsx` | Earlier Base UI wrappers + `buttonVariants` (cva) in one file (Button, Checkbox, Dialog/AlertDialog, Select, Switch, Toggle, Radio, Progress, Separator, Field/Label). | transitional — wrappers migrate into `primitives/` as touched (Badge moved to `primitives/badge.tsx` earlier; Button/Select/etc. still live here) |
| `src/*.tsx` / `src/*.ts` (top-level) | Feature components + pure logic (e.g. `chat-view.tsx`, `composer.tsx`, `sandbox-boundary-prompt.tsx`, `session-list-panel.tsx`, plus pure helpers like `materialize.ts`, `redact.ts`, `smooth-stream.ts`). | stable |
| `src/components.tsx` | Re-export barrel for the feature components above (ChatView, Composer, SandboxBoundaryPrompt, …). | stable |

`src/index.ts` is the package barrel. It follows an **off-barrel convention**: some styling tables and per-surface helpers are deliberately *not* re-exported, so they stay renamable/removable without a public-API break. A symbol earns barrel export when it has a **cross-package consumer or an explicit public-API need** — not merely a second in-package consumer (`attachment-file-card` has two in-package consumers, `chat-view` and `composer`, but stays off-barrel). Don't add to the barrel speculatively. This README is the source of truth for the barrel promotion rule.

## `data-slot` hooks

Most primitives expose a stable `data-slot="<name>"` attribute so renderer CSS can target a slot (e.g. `[data-slot="dialog-header"]`) rather than a drifting class. Exceptions without one: `choice-card`, `spinner`, `scroll-area`, `segmented` — their styling lives on the consumer's class or an underlying Base UI component, so a `[data-slot="..."]` selector won't match. New primitives should still expose a `data-slot`.

## Consuming

```ts
import { Button, ChatView, Composer, Badge, Chip, PageHeader, useToast } from '@maka/ui';
```

Sub-path exports (declared in `package.json` `exports`): `@maka/ui/artifact-preview-registry`, `@maka/ui/assistant-stream`, `@maka/ui/icons`, `@maka/ui/maka-uri`, `@maka/ui/smooth-stream`. (`@maka/ui/icons` re-exports Lucide symbols; model-provider brand logos live in the renderer's `settings/provider-*`, not here — bot-provider logos are in `@maka/ui`'s `bot-brand-logo`.)

Renderer CSS may target a primitive via its `data-slot` attribute, never by overriding the primitive's own utility classes.

## Where new code goes

- **New primitive** (button-like, dialog-like, form control) → a new file in `src/primitives/`, exposing `data-slot`, re-exported from `index.ts` (primitives are the public surface).
- **New feature component** → top-level `src/<name>.tsx`, kept as a relative import until it has a cross-package consumer or an explicit public-API need; then re-export it from `src/components.tsx` (`index.ts` does `export * from './components.js'`, so it lands on the barrel automatically).
- **Don't** add a per-surface hand-rolled CSS recipe in the renderer if a primitive can carry it — extend the primitive's API/slots instead.
- **Don't** re-export a symbol onto the barrel without a cross-package consumer or explicit public-API need; keep it a relative import even with multiple in-package consumers (a cross-package consumer can't use a relative import — `previewVariants` is re-exported for exactly that reason).

## Convergence direction (transitional surfaces)

Acknowledged transitional states — not TODOs; track actual work in issues/PRs.

- `ui.tsx` ↔ `primitives/`: end state is one primitive layer in `primitives/`. Wrappers in `ui.tsx` move over when touched (Badge is the precedent). `buttonVariants` has external consumers, so its move is a coordinated rename, not a silent one.

## Contracts & guardrails

Product design intent lives in `DESIGN.md`.

Component behavior, ARIA, keyboard, tone, and token contracts are enforced by source and the focused contract tests (`*-converge-contract.test.ts`, `state-token-governance-*`, and related suites). `docs/frontend-css-governance.md` owns the remaining cross-cutting CSS rules.

Selected primitives and features have stories (`stories/`) and unit tests (`src/__tests__/`); coverage is partial, not exhaustive. Build/test entry points are the npm scripts in the root `package.json` (see the top-level `README.md`).
