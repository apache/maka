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

A bilingual Astro homepage and download guide with an independent manifest and lockfile.

```sh
just website-setup
just website-dev
just website-check
```

Commands can also be run from this directory with npm. Site dependency changes update `website/package-lock.json`.

Copy lives in `src/copy/`; both languages share one type and the built-page tests verify navigation, link previews, accessibility metadata and local asset loading. Product and contributor guidance links to the repository's maintained documents.

Machine-readable entry points live in `public/`: page changes must update `sitemap.xml`, and authoritative document changes must update `llms.txt`. The latter links to raw Markdown in the repository rather than copying documentation into the site.

The design tokens live in `src/styles/site.css`. Geist and Geist Mono are self-hosted under the SIL Open Font License. `assets/logo.png` is the product mark; `src/assets/incubator.png` is the unmodified Apache Incubator logo from https://www.apache.org/logos/res/incubator/default.png, used as an ASF trademark.

After changing the hero, run `npm --prefix website run social-preview` from the repository root to regenerate the localized social images and their text manifest.

`.github/workflows/website.yml` validates pull requests and publishes from main to `asf-site`. Release-candidate tags and explicit stage names publish to `site/<name>-staging`; non-main refs require a stage name. Only the built site, its license/notice and site configuration are published.
