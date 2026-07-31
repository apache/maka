# Frontend CSS governance

[中文](./frontend-css-governance.zh-CN.md)

Maka's frontend styling combines Tailwind v4 with handwritten renderer CSS. Some renderer surfaces still override shared `@maka/ui` primitives, so cascade order is an explicit contract rather than an implementation detail.

## 1. Entry file

- `apps/desktop/src/renderer/styles.css` is an entry file only.
- It may contain `@import`, `@source`, `@theme`, and other top-level orchestration statements.
- New per-surface selector blocks belong in `apps/desktop/src/renderer/styles/**/*.css`.
- Historical recipes at the end of `maka-tokens.css` and `reference-shell.css` are transitional exceptions. Do not add new surface rules to them.

### Selector naming

- Shared renderer and `@maka/ui` selectors use the kebab-case `.maka-*` dialect.
- The established `styles/settings/**` surface uses camelCase `.settings*` selectors. Keep that dialect for settings-local selectors instead of mixing both forms within one surface.
- Moving existing settings selectors between concern files does not require a repository-wide rename; any future naming migration should be handled as an explicit compatibility change.

## 2. Layers

- Pure presentation rules that do not override shared primitives or Tailwind utilities should use `@layer base` or `@layer components` where practical.
- Use `@import "./file.css" layer(components)` only when the build chain explicitly supports it.
- Do not place `@import` inside an `@layer` block.
- A selector that must override a shared primitive's Tailwind utility must remain outside `@layer components` until the primitive seam is fixed.

## 3. Rules that must outrank Tailwind utilities

These selectors depend on beating Tailwind utilities on the same element. Since #1565 PR 1 they do so by living in the `maka.legacy` layer, which `cascade-layers.css` declares after `utilities` (before that they relied on being unlayered). The declaration in `cascade-layers.css` is append-only: later migration PRs may add layers but must never reorder the existing five.

- `.maka-nav-row`
- `html[data-os="darwin"] .maka-nav-row`
- `.settingsHealthRefresh`
- `.settingsPermissionRefresh`
- `.settingsBotList button`

The guard lives in `apps/desktop/src/main/__tests__/renderer-style-layer-cascade-contract.test.ts`. Update that contract in the same PR if the underlying primitive changes.

## 4. `!important`

- `!important` is allowed by default only for accessibility helpers such as `.maka-visually-hidden`, and for reduced-motion or e2e-fixture overrides.
- Every other use requires an adjacent `Justified:` comment and an entry in `renderer-important-audit-contract.test.ts`.
- Prefer a JSX utility-class reset when the primitive can express the behavior directly.

## 5. Tokens

- Shared custom properties belong in `apps/desktop/src/renderer/maka-tokens.css`.
- Component-local properties are allowed only with a `/* local: ... */` comment.
- Do not add raw colors, radii, or ungoverned z-index values.

## 6. Dead CSS

- `scripts/check-dead-css.mjs` scans `apps/desktop/src/renderer/styles/**/*.css` and `apps/desktop/src/renderer/reference-shell.css`.
- Runtime-generated class names that static search cannot find must be explicitly allowlisted.
- Change `scripts/check-dead-css-baseline.json` only after review confirms the class-count change.

## 7. Contract tests

- Tests that inspect effective renderer CSS must read it through `css-test-helpers.ts` or `contract-css-helpers.ts`.
- Do not inspect only `styles.css` when the assertion concerns effective rules.
- Directly inspect `styles.css` only to enforce its entry-file contract.

## 8. Change order

When changing renderer CSS:

1. Point contract tests at the effective CSS source.
2. Move real rule blocks out of `styles.css` into surface files.
3. Layer only rules that do not override shared utilities.
4. Remove dead selectors.
5. Remove remaining `!important` only after primitive and layer ownership is stable.

## 9. Governing principles

- Make CI guards trustworthy before structural convergence.
- Delete dead CSS before aesthetic refactoring.
- Resolve shared `Button`, `Textarea`, and `EmptyState` overrides at the component API seam instead of accumulating renderer specificity.
- Every change to Tailwind cascade order requires a contract test and the narrowest relevant regression check.
