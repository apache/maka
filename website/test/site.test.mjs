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
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dist = new URL('../dist/', import.meta.url);
const page = (path) => readFileSync(new URL(path, dist), 'utf8');
const locales = ['en', 'zh-CN'];
const pages = ['index.html', 'downloads/index.html'];

const positioning =
  'Apache Maka (Incubating) is a high-performance agent workspace that keeps a complete record of everything it did.';
const disclaimer =
  'Apache Maka is an effort undergoing incubation at The Apache Software Foundation (ASF), sponsored by the Apache Incubator.';
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

test('the root redirects to the English homepage', () => {
  assert.match(page('index.html'), /url=\/en\//u);
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

test('both languages link the same documents', () => {
  for (const path of pages) {
    const [en, zh] = locales.map((locale) =>
      [...hrefs(page(`${locale}/${path}`))].map(normalize).sort(),
    );
    assert.deepEqual(zh, en, path);
  }
});

test('the site does not load anything from a third party', () => {
  for (const locale of locales) {
    for (const path of pages) {
      const html = page(`${locale}/${path}`);
      const loaded = [...html.matchAll(/(?:src|href)="(https?:[^"]+)"[^>]*>/gu)]
        .filter(([tag]) => /<(?:link[^>]*rel="(?:stylesheet|preload|icon)"|script|img)/u.test(tag))
        .map(([, url]) => url);
      assert.deepEqual(loaded, [], `${locale}/${path}`);
    }
  }
});
