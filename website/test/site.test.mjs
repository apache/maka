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

const dist = new URL('../dist/', import.meta.url);
const page = (path) => readFileSync(new URL(path, dist), 'utf8');
const locales = ['en', 'zh-CN'];
const pages = ['index.html', 'downloads/index.html'];

// DISCLAIMER is the project's copy of the Incubator disclaimer, so the
// site has to carry that paragraph rather than a wording of its own.
const disclaimer = readFileSync(new URL('../../DISCLAIMER', import.meta.url), 'utf8')
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

const canonicalUrls = [
  'https://maka.apache.org/en/',
  'https://maka.apache.org/zh-CN/',
  'https://maka.apache.org/en/downloads/',
  'https://maka.apache.org/zh-CN/downloads/',
];
const llmsSources = [
  'ARCHITECTURE.md',
  'platform/event-log/README.md',
  'plugins/README.md',
  'packages/cli/README.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
];

test('the root redirects to the English homepage without a delay', () => {
  assert.match(page('index.html'), /content="0;url=\/en\/"/u);
});

test('machine-readable entry points describe the published site', () => {
  const robots = page('robots.txt');
  assert.match(robots, /^User-agent: \*\nAllow: \/$/mu);
  assert.match(robots, /^Sitemap: https:\/\/maka\.apache\.org\/sitemap\.xml$/mu);

  const sitemapUrls = [...page('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/gu)].map(
    ([, url]) => url,
  );
  assert.deepEqual(sitemapUrls, canonicalUrls);
  assert.ok(!sitemapUrls.includes('https://maka.apache.org/'));

  const llms = page('llms.txt');
  assert.match(llms, /^# Apache Maka \(Incubating\)$/mu);
  assert.ok(
    llms.includes(
      'Apache Maka (Incubating) is a high-performance agent workspace that keeps a complete record of everything it did.',
    ),
  );
  for (const url of canonicalUrls) assert.ok(llms.includes(url), url);

  const rawUrls = [
    ...llms.matchAll(/https:\/\/raw\.githubusercontent\.com\/apache\/maka\/main\/([^\s)]+)/gu),
  ].map(([, p]) => p);
  assert.deepEqual(rawUrls, llmsSources);
  for (const p of rawUrls)
    assert.doesNotThrow(() => statSync(new URL(`../../${p}`, import.meta.url)));
});

test('downloads pages list the latest approved Apache source release', () => {
  for (const locale of locales) {
    const html = page(`${locale}/downloads/index.html`);
    assert.ok(
      html.includes(
        'https://www.apache.org/dyn/closer.lua/incubator/maka/0.2.2-incubating/apache-maka-0.2.2-incubating-src.tar.gz',
      ),
      locale,
    );
    assert.ok(
      html.includes(
        'https://downloads.apache.org/incubator/maka/0.2.2-incubating/apache-maka-0.2.2-incubating-src.tar.gz.sha512',
      ),
      locale,
    );
    assert.ok(
      html.includes(
        'https://downloads.apache.org/incubator/maka/0.2.2-incubating/apache-maka-0.2.2-incubating-src.tar.gz.asc',
      ),
      locale,
    );
    assert.ok(html.includes('https://archive.apache.org/dist/incubator/maka/'), locale);
  }
});

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
    // The alt includes the positioning line and scene description for accessibility.
    const alt = meta(html, 'og:image:alt');
    assert.equal(meta(html, 'twitter:image:alt'), alt, path);
    const description = meta(page(`${locale}/index.html`), 'description');
    assert.ok(alt.startsWith(description + ' ') && alt.slice(description.length).trim(), path);
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
    const buttons = [
      ...page(`${locale}/downloads/index.html`).matchAll(/<button class="copy"[^>]*>/gu),
    ];
    assert.ok(buttons.length > 0, locale);
    const names = buttons.map(([button]) => /aria-label="([^"]*)"/u.exec(button)?.[1]);
    assert.ok(names.every((name) => name?.trim()), locale);
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
  for (const locale of locales) {
    for (const path of pages) {
      assert.deepEqual(thirdPartyLoads(page(`${locale}/${path}`)), [], `${locale}/${path}`);
    }
  }
});
