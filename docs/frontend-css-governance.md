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

# Frontend CSS governance

[中文](./frontend-css-governance.zh-CN.md)

Maka's frontend styling combines Astryx, `@maka/ui` product compositions, and renderer surface CSS. Cascade order is an explicit contract rather than an implementation detail.

## 1. Entry file

- `apps/desktop/src/renderer/styles.css` is an entry file only.
- It may contain `@import` and other top-level orchestration statements.
- New per-surface selector blocks belong in `apps/desktop/src/renderer/styles/**/*.css`.
- Historical recipes at the end of `maka-tokens.css` and `reference-shell.css` are transitional exceptions. Do not add new surface rules to them.

### Selector naming

- Shared renderer and `@maka/ui` selectors use the kebab-case `.maka-*` dialect.
- The established `styles/settings/**` surface uses camelCase `.settings*` selectors. Keep that dialect for settings-local selectors instead of mixing both forms within one surface.
- Moving existing settings selectors between concern files does not require a repository-wide rename; any future naming migration should be handled as an explicit compatibility change.

## 2. Layers

- Pure presentation rules should use `@layer base` or `@layer components` where practical.
- Use `@import "./file.css" layer(components)` only when the build chain explicitly supports it.
- Do not place `@import` inside an `@layer` block.

Astryx reset and component layers come first; Maka base tokens and product `components` come later. Keep layer ownership at the closest existing seam instead of adding a higher-priority compatibility layer.

## 4. `!important`

- `!important` is allowed by default only for accessibility helpers such as `.maka-visually-hidden`, and for reduced-motion or e2e-fixture overrides.
- Every other use requires an adjacent `Justified:` comment.
- Prefer fixing the primitive API or semantic class when it can express the behavior directly.

## 5. Tokens

- Shared custom properties belong in `apps/desktop/src/renderer/maka-tokens.css`.
- Component-local properties are allowed only with a `/* local: ... */` comment.
- Do not add raw colors, radii, or ungoverned z-index values.

## 6. How these rules are checked

These rules are conventions enforced in review. Static correctness belongs to
Biome, Knip, and typecheck; accessibility keeps its focused check. CSS usage and
Story prose are not decided by repository-wide regex baselines.

- Renderer CSS behavior is verified where it renders: Storybook, the app, or an
  e2e assertion on the real surface.
- Remove selectors with the source or surface that owned them instead of
  maintaining an allowlist of strings that may be generated at runtime.

## 7. Change order

When changing renderer CSS:

1. Move real rule blocks out of `styles.css` into surface files.
2. Keep generic component chrome in Astryx and product composition in `@maka/ui` or the matching renderer surface.
3. Remove dead selectors.
4. Remove remaining `!important` only after primitive and layer ownership is stable.

## 8. Governing principles

- Delete dead CSS before aesthetic refactoring.
- Resolve shared `Button`, `Textarea`, and `EmptyState` overrides at the component API seam instead of accumulating renderer specificity.
- Every change to cascade order requires the narrowest relevant regression check on the rendered surface.
