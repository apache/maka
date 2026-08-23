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

# @maka/ui

Shared UI layer for the Maka desktop app. Astryx is the authority for generic components; Maka keeps product-specific composition and state. The package is consumed by `apps/desktop`'s renderer, while the preload bridge imports types only.

The published Astryx API is a fixed dependency boundary. New consumers adapt to its taxonomy instead of recreating retired Maka APIs or styling its internal DOM; existing renderer overrides are acknowledged transitional states documented in `apps/desktop/src/renderer/README.md`.

## Layer map

Four export surfaces, in the order to look:

| Surface | Role | Status |
|---|---|---|
| `@astryxdesign/core` re-exports in `src/index.ts` | Generic design-system components such as Button, TextInput, TextArea, CheckboxInput, RadioList, and Switch. | target authority |
| `src/primitives/` | Maka-specific compositions that do not duplicate an Astryx component. | product-specific |
| `src/ui.tsx` | Shared product compositions and compatibility-free exports. | stable |
| `src/*.tsx` / `src/*.ts` (top-level) | Feature components + pure logic (e.g. `chat-view.tsx`, `composer.tsx`, `sandbox-boundary-prompt.tsx`, `session-list-panel.tsx`, plus pure helpers like `materialize.ts` and `redact.ts`). | stable |
| `src/components.tsx` | Re-export barrel for the feature components above (ChatView, Composer, SandboxBoundaryPrompt, …). | stable |

`src/index.ts` is the package barrel. It follows an **off-barrel convention**: some styling tables and per-surface helpers are deliberately *not* re-exported, so they stay renamable/removable without a public-API break. A symbol earns barrel export when it has a **cross-package consumer or an explicit public-API need**, not merely a second in-package consumer. Don't add to the barrel speculatively. This README is the source of truth for the barrel promotion rule.

## Consuming

```ts
import { Badge, Button, ChatView, Composer, PageHeader, useToast } from '@maka/ui';
```

Sub-path exports (declared in `package.json` `exports`): `@maka/ui/artifact-preview-registry`, `@maka/ui/assistant-stream`, `@maka/ui/icons`, and `@maka/ui/maka-uri`. (`@maka/ui/icons` re-exports Lucide symbols; model-provider brand logos live in the renderer's `settings/provider-*`, not here — bot-provider logos are in `@maka/ui`'s `bot-brand-logo`.)

New renderer CSS owns product layout containers only. It must not target Astryx internal elements, roles, slots, or generated classes to restyle component chrome.

## Where new code goes

- **Generic component need** → use the closest published Astryx taxonomy and redesign the Maka consumer when the old shape does not fit.
- **Irreducible product control** → add the smallest product-named native or Astryx composition; do not create a generic compatibility primitive.
- **New feature component** → top-level `src/<name>.tsx`, kept as a relative import until it has a cross-package consumer or an explicit public-API need; then re-export it from `src/components.tsx` (`index.ts` does `export * from './components.js'`, so it lands on the barrel automatically).
- **Don't** add a per-surface hand-rolled CSS recipe when Astryx public props can express the need. If they cannot, redesign the consumer; keep a product-owned control only for an irreducible product interaction.
- **Don't** re-export a symbol onto the barrel without a cross-package consumer or explicit public-API need; keep it a relative import even with multiple in-package consumers (a cross-package consumer can't use a relative import — `previewVariants` is re-exported for exactly that reason).

## Contracts & guardrails

Product design intent lives in `DESIGN.md`.

Component behavior, ARIA, keyboard, tone, and token contracts are enforced by source, behavioral tests, focused `scripts/check-*.mjs` commands, review, and rendered-surface verification. `docs/frontend-css-governance.md` owns the remaining cross-cutting CSS rules.

Selected primitives and features have stories (`stories/`) and unit tests (`src/__tests__/`); coverage is partial, not exhaustive. Build/test entry points are the npm scripts in the root `package.json` (see the top-level `README.md`).
