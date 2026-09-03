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

# maka.apache.org

The podling website: a bilingual homepage and a downloads page, built with Astro and published through `.asf.yaml`. Docs, security policy, community, releases and architecture stay authoritative where they already live in this repository; the site links to them and copies nothing.

```sh
npm --workspace @maka/website run dev    # http://localhost:4321/en/
npm --workspace @maka/website run build  # website/dist
npm --workspace @maka/website run test:dist
```

## Content

- The positioning sentence, the page structure and the three download paths follow the consensus in [#4307](https://github.com/apache/maka/discussions/4307). The homepage direction (Astryx Centered Hero) was chosen by vote in the same thread.
- English and Chinese are one page each in `src/copy/`. Both share the `Copy` type in `src/copy/types.ts`, so a section, claim or link added to one language fails to type-check until the other has it too, and `test/site.test.mjs` asserts the built pages link the same documents. Yuhan Lei (@Astro-Han) keeps the two in sync.
- Numbers on the homepage are drawn from the reports in [`docs/eval/`](../docs/eval/) and link to them. The reports own the numbers.
- Fact-check cadence: the homepage is re-read against the product at every release, and whenever the positioning, the primary journey, platform support or the trust boundary changes. The README's *Get Maka* section, `SECURITY.md` and `docs/eval/` are the sources to check against.

## Design

Colour, radius and surface tokens are the desktop app's defaults, copied by value from `apps/desktop/src/renderer/maka-tokens.css` into `src/styles/site.css`. The site follows the viewer's colour scheme until they pick one with the toggle in the top bar, which is remembered in that browser. Fonts are Geist and Geist Mono (SIL Open Font License 1.1), self-hosted from the `@fontsource-variable` packages the desktop app already depends on, with each package's OFL text published at `/licenses/<package>/LICENSE`; nothing loads from a third party. The logo is `apps/desktop/assets/app-icons/sky.png`, the same file the README uses. `src/assets/incubator.png` is the Apache Incubator logo as published at https://www.apache.org/logos/res/incubator/default.png, an ASF trademark used here as the Incubator branding guide asks; it is not edited.

## Publishing

`.github/workflows/website.yml` builds the site and pushes `website/dist` plus `LICENSE`, `NOTICE` and a site-only `.asf.yaml` as an orphan commit:

| Trigger | Branch | Served at |
| --- | --- | --- |
| Push to `main` touching the site | `asf-site` | https://maka.apache.org |
| Push of a release-candidate tag (`v*-rc*`) | `site/<tag>-staging` | https://maka-<tag>.staged.apache.org |
| `workflow_dispatch` with a `stage` name | `site/<stage>-staging` | https://maka-<stage>.staged.apache.org |

A `workflow_dispatch` without a `stage` name publishes only from `main`; any other ref fails instead of overwriting the live site. The published `.asf.yaml` carries just `publish: whoami: asf-site` and `staging: autostage: site/*`, the same layout Apache OpenDAL uses; the repository settings in the root `.asf.yaml` stay on `main`, the only branch asfyaml reads them from. Nothing else in the repository is published.
