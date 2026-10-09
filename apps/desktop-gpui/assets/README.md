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

# Assets

Files embedded into the binary through `shared::assets::AppAssets`.

| File | Origin | License |
| --- | --- | --- |
| `maka-icon.png` | `apps/desktop/assets/app-icons/sky.png` in this repository, last changed in commit `ce0e5931a8d129193d1812617d07c7f43728b621` (2026-08-23), copied unchanged | Apache-2.0 |

`maka-icon.png` is also the source of the macOS app icon:
`scripts/bundle-macos.sh` scales it into the bundle's `AppIcon.icns`.

## `app-icons/*.png`

Maka Desktop's app icon set, which Settings › Appearance › App icon offers
and the Dock shows: `apps/desktop/assets/app-icons/*.png` in this
repository (at the commit `MAKA_PIN` names), copied
unchanged, and `default.png`, Desktop's `apps/desktop/assets/icon.png` (the
`default` choice, Classic). Apache-2.0. `app-icons/thumbnails/` holds the
same art scaled to 128 px for the picker (Desktop's `PREVIEW_SIZE`).
`scripts/app-icons.sh` copies and scales them again. They are embedded by
`settings::app_icon`, not served through `AppAssets`.

Icons come from the Lucide set bundled with `gpui-kit` (ISC). An icon
outside the `gpui-kit` default bundle must be listed in `ExtraIcons` in
`crates/shared/src/assets.rs`, or it renders as nothing.

## `icons/maka/*.svg`

Maka GPUI's own icon set, drawn for this repository on a 16px grid with a 1.5px round stroke
(source: `scripts/design-icons.py`, whose `--write` renders every file here; first drawn in
Paper, see `docs/design/polish-2026-09-26.md`). Apache-2.0, same as the repository.

## `brand/maka-wordmark.svg`

The Maka wordmark, from `packages/core/src/maka-wordmark.ts` in this repository (Apache-2.0),
traced from the Maka app icon. Filled with `currentColor`; render it in the brand colour.
