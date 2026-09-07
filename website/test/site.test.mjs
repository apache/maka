/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * The parts of the built site that ASF policy and #4307 require, checked on
 * the HTML that will be published rather than on the source that produced it.
 */
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import test from 'node:test';

import { headlineText, heroText } from '../scripts/hero-text.mjs';

const dist = new URL('../dist/', import.meta.url);
const repo = new URL('../../', import.meta.url);
const page = (path) => readFileSync(new URL(path, dist), 'utf8');
const locales = ['en', 'zh-CN'];
const pages = ['index.html', 'downloads/index.html'];

const positioning =
  'Apache Maka (Incubating) is a high-performance agent workspace that keeps a complete record of everything it did.';
// DISCLAIMER-WIP is the project's copy of the Incubator disclaimer, so the
// site has to carry that paragraph rather than a wording of its own.
const disclaimer = readFileSync(new URL('../../DISCLAIMER-WIP', import.meta.url), 'utf8')
  .split('\n\n')[0]
  .replace(/\s+/gu, ' ')
  .trim();
// The copyright and trademark line stays in English on every page, like the disclaimer.
const trademark =
  'Copyright © 2026 The Apache Software Foundation, licensed under the Apache License, Version 2.0. Apache Maka, Apache Incubator, Apache and the Apache feather logo are trademarks of The Apache Software Foundation.';
// The links the ASF website policy requires, plus the Incubator and the code of conduct.
const footer = [
  'https://www.apache.org/',
  'https://incubator.apache.org/',
  'https://www.apache.org/licenses/',
  'https://www.apache.org/events/current-event.html',
  'https://privacy.apache.org/policies/privacy-policy-public.html',
  'https://www.apache.org/security/',
  'https://www.apache.org/foundation/sponsorship.html',
  'https://www.apache.org/foundation/thanks.html',
  'https://www.apache.org/foundation/policies/conduct.html',
];

const hrefs = (html) => new Set([...html.matchAll(/href="([^"]+)"/gu)].map(([, href]) => href));

// Links that legitimately differ by language: the localized twin of a
// document, and the site's own pages. Everything else must match.
const normalize = (href) => href.replace(/\.zh-CN\.md$/u, '.md').replace(/^\/zh-CN\//u, '/en/');

test('the root redirects to the English homepage without a delay', () => {
  assert.match(page('index.html'), /content="0;url=\/en\/"/u);
});

const readmeAlt = (locale) =>
  readFileSync(new URL(locale === 'en' ? 'README.md' : 'README.zh-CN.md', repo), 'utf8').match(
    /<img alt="([^"]+)" src="\.\/\.github\/assets\/readme-hero\./u,
  )[1];

const meta = (html, key) =>
  [...html.matchAll(/<meta (?:property|name)="([^"]+)" content="([^"]*)"/gu)].find(
    ([, name]) => name === key,
  )?.[2];

// Link previews on X, Slack and the like are built from these tags alone, so
// every page carries them, the image URL is absolute and the image ships. The
// root page too: crawlers read it as-is rather than follow the meta refresh.
test('every page carries a complete link preview', () => {
  for (const path of ['index.html', ...locales.flatMap((l) => pages.map((p) => `${l}/${p}`))]) {
    const html = page(path);
    const locale = path.startsWith('zh-CN/') ? 'zh-CN' : 'en';
    for (const key of ['og:title', 'og:description', 'og:url']) {
      assert.ok(meta(html, key), `${path} ${key}`);
    }
    // The alt is the language's positioning line plus the scene description the
    // README hero already carries, so the two never drift apart.
    const alt = meta(html, 'og:image:alt');
    assert.equal(meta(html, 'twitter:image:alt'), alt, path);
    assert.equal(
      alt,
      `${meta(page(`${locale}/index.html`), 'description')} ${readmeAlt(locale)}`,
      path,
    );
    assert.equal(meta(html, 'twitter:card'), 'summary_large_image', path);
    assert.equal(meta(html, 'og:locale'), locale === 'en' ? 'en_US' : 'zh_CN', path);
    assert.match(meta(html, 'og:url'), /^https:\/\/maka\.apache\.org\//u, path);
    const image = meta(html, 'og:image');
    assert.match(image, /^https:\/\/maka\.apache\.org\/_astro\/social\.[^/]+\.png$/u, path);
    assert.equal(meta(html, 'twitter:image'), image, path);
    assert.ok(image.includes(`/social.${locale}.`), `${path} shows the ${locale} hero`);
    const [width, height] = ['og:image:width', 'og:image:height'].map((k) => Number(meta(html, k)));
    assert.equal(width / height, 1200 / 630, path);
    assert.ok(
      statSync(new URL(image.slice('https://maka.apache.org/'.length), dist)).size > 0,
      image,
    );
  }
});

test('every copy button on the downloads page has its own accessible name', () => {
  for (const locale of locales) {
    const names = [
      ...page(`${locale}/downloads/index.html`).matchAll(
        /<button class="copy"[^>]*aria-label="([^"]+)"/gu,
      ),
    ].map(([, name]) => name);
    assert.equal(names.length, 5, locale);
    assert.equal(new Set(names).size, names.length, locale);
  }
});

test('the font licenses ship with the fonts', () => {
  for (const pkg of ['geist', 'geist-mono']) {
    assert.match(page(`licenses/${pkg}/LICENSE`), /SIL Open Font License/u);
  }
});

test('every page identifies the podling and carries the Incubator disclaimer', () => {
  for (const locale of locales) {
    for (const path of pages) {
      const html = page(`${locale}/${path}`);
      assert.ok(html.includes('Apache Maka (Incubating)'), `${locale}/${path}`);
      assert.ok(html.includes(disclaimer), `${locale}/${path}`);
      assert.ok(html.includes(trademark), `${locale}/${path}`);
      for (const href of footer) assert.ok(hrefs(html).has(href), `${locale}/${path} ${href}`);
    }
  }
});

test('the brand links to the homepage of the current language on every page', () => {
  for (const locale of locales) {
    for (const path of pages) {
      const [, home] = page(`${locale}/${path}`).match(/<a class="brand" href="([^"]+)"/u);
      assert.equal(home, `/${locale}/`, `${locale}/${path}`);
    }
  }
});

test('the English homepage uses the positioning sentence unchanged', () => {
  assert.ok(page('en/index.html').includes(positioning));
});

// #4307 settled one sentence for the homepage, the READMEs and the repository
// description. The description is a folded YAML scalar, so compare it unfolded.
test('the READMEs and the repository description open with the same sentence', () => {
  const root = new URL('../../', import.meta.url);
  const read = (path) => readFileSync(new URL(path, root), 'utf8');
  assert.ok(read('README.md').includes(positioning), 'README.md');
  assert.ok(
    read('README.zh-CN.md').includes(
      'Apache Maka（孵化中）是一个高性能的 Agent 工作台，并完整记录它做过的每一件事。',
    ),
    'README.zh-CN.md',
  );
  const [, description] = read('.asf.yaml').match(/description: >-\n((?: {4}.*\n)+)/u);
  assert.equal(description.replace(/\s+/gu, ' ').trim(), positioning);
});

// The README heroes are screenshots of these pages, so the copy the render
// baked in has to be the copy the pages carry now. Compare through the
// manifest the render writes, which needs no browser and no pixels.
test('the committed README heroes and social previews were rendered from the current hero copy', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../.github/assets/readme-hero.json', import.meta.url), 'utf8'),
  );
  const rerender = 'run `npm --workspace @maka/website run readme-hero` and commit the images';
  for (const locale of locales) {
    const html = page(`${locale}/index.html`);
    assert.equal(heroText(html), manifest[locale], `${locale}: ${rerender}`);
    assert.equal(headlineText(html), manifest.headline[locale], `${locale} headline: ${rerender}`);
  }
});

test('both languages link the same documents', () => {
  for (const path of pages) {
    const [en, zh] = locales.map((locale) =>
      [...hrefs(page(`${locale}/${path}`))].map(normalize).sort(),
    );
    assert.deepEqual(zh, en, path);
  }
});

// Every absolute URL a page fetches while loading: scripts, images and the
// links that pull in a resource, but not the links a visitor clicks.
const thirdPartyLoads = (html) =>
  [...html.matchAll(/<(script|img|link)\b[^>]*>/gu)]
    .filter(
      ([tag, name]) =>
        name !== 'link' || /rel="(?:stylesheet|preload|modulepreload|icon)"/u.test(tag),
    )
    .flatMap(([tag]) => [...tag.matchAll(/(?:src|href)="(https?:[^"]+)"/gu)].map(([, url]) => url));

test('the site does not load anything from a third party', () => {
  assert.deepEqual(
    thirdPartyLoads(
      '<script src="https://cdn.example/t.js"></script><link rel="stylesheet" href="https://fonts.example/a.css"><img src="https://img.example/a.png"><a href="https://www.apache.org/">ASF</a>',
    ),
    ['https://cdn.example/t.js', 'https://fonts.example/a.css', 'https://img.example/a.png'],
  );
  for (const locale of locales) {
    for (const path of pages) {
      assert.deepEqual(thirdPartyLoads(page(`${locale}/${path}`)), [], `${locale}/${path}`);
    }
  }
});
