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
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

import { heroText } from './hero-text.mjs';

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

// The scene only: the README carries the headline, the lede and the links as
// its own text, and reduced motion shows every event of the turn at once.
const readmeOnly = `
  .display, .cta, .fine, .lede { display: none !important; }
  .hero { padding-top: 32px !important; padding-bottom: 32px !important; }
  .scene { margin-top: 0 !important; }
`;

// npm ci installs the Playwright package but not a browser, so a clean
// checkout has to be able to fetch one before this command can run.
const executable = (() => {
  try {
    return chromium.executablePath();
  } catch {
    return undefined;
  }
})();
if (!executable || !existsSync(executable)) {
  execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['playwright', 'install', 'chromium'],
    {
      stdio: 'inherit',
    },
  );
}

const manifest = {};
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-CN']) {
    manifest[locale] = heroText(readFileSync(join(dist, locale, 'index.html'), 'utf8'));
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
  // The copy these images were made from, so the site test can tell when the
  // pages have moved on and the committed images have not.
  const path = join(assets, 'readme-hero.json');
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(path);
} finally {
  await browser.close();
  server.close();
}
