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
 * Renders the README hero images from the built site, so the README shows
 * the same headline and RuntimeEvents scene as maka.apache.org. Run
 * `npm --workspace @maka/website run readme-hero` after changing the hero
 * copy or styles and commit the PNGs it writes to `.github/assets/`.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const assets = fileURLToPath(new URL('../../.github/assets/', import.meta.url));
const types = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// The built pages reference /_astro/... absolutely, so serve dist over HTTP.
const server = http.createServer((request, response) => {
  let path = join(dist, decodeURIComponent(new URL(request.url, 'http://x').pathname));
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
  if (!existsSync(path)) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
  response.end(readFileSync(path));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// Headline and scene only: the README supplies its own lede and links, and
// reduced motion shows every event of the turn at once.
const readmeOnly = `
  .cta, .fine, .lede { display: none !important; }
  .hero { padding-top: 48px !important; padding-bottom: 48px !important; }
  .scene { margin-top: 36px !important; }
`;

const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-CN']) {
    for (const colorScheme of ['light', 'dark']) {
      const page = await browser.newPage({
        viewport: { width: 1600, height: 1000 },
        deviceScaleFactor: 2,
        colorScheme,
        reducedMotion: 'reduce',
      });
      await page.goto(`${origin}/${locale}/`);
      await page.addStyleTag({ content: readmeOnly });
      await page.evaluate(() => document.fonts.ready);
      const path = join(assets, `readme-hero.${locale}.${colorScheme}.png`);
      await page.locator('.hero').screenshot({ path });
      console.log(path);
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
