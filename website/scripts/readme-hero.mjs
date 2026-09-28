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
 * Renders the README hero images and the social preview images from the
 * built site, so the README and every link card show the same headline and
 * RuntimeEvents scene as maka.apache.org. Run
 * `npm --workspace @maka/website run readme-hero` after changing the hero
 * copy or styles and commit the PNGs it writes to `.github/assets/` and
 * `website/src/assets/`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

import { headlineText, heroText } from './hero-text.mjs';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const assets = fileURLToPath(new URL('../../.github/assets/', import.meta.url));
const social = fileURLToPath(new URL('../src/assets/', import.meta.url));
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

// The social preview: the brand, the headline and the scene, centred in the
// 1200×630 frame link previews are cut to. Light only, since a preview shows
// on the sharing site's own background, and the sections below the hero are
// dropped so the frame ends where the scene does.
const socialOnly = `
  .lede, .cta, .fine, .hero ~ *, footer { display: none !important; }
  .nav > :not(.brand) { display: none !important; }
  html, body { overflow: hidden !important; }
  .hero {
    box-sizing: border-box !important;
    min-height: 570px !important;
    padding: 0 0 12px !important;
    display: flex !important;
    flex-direction: column !important;
    justify-content: center !important;
  }
  .scene { margin-top: 28px !important; }
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
const headlines = {};
const browser = await chromium.launch();
try {
  for (const locale of ['en', 'zh-CN']) {
    const html = readFileSync(join(dist, locale, 'index.html'), 'utf8');
    manifest[locale] = heroText(html);
    headlines[locale] = headlineText(html);
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
    const page = await browser.newPage({
      viewport: { width: 1200, height: 630 },
      deviceScaleFactor: 2,
      colorScheme: 'light',
      reducedMotion: 'reduce',
    });
    await page.goto(`${origin}/${locale}/`);
    await page.addStyleTag({ content: socialOnly });
    await page.evaluate(() => document.fonts.ready);
    const path = join(social, `social.${locale}.png`);
    await page.screenshot({ path });
    console.log(path);
    await page.close();
  }
  // The copy these images were made from, so the site test can tell when the
  // pages have moved on and the committed images have not. The README heroes
  // show the scene; the social previews show the headline above it.
  manifest.headline = headlines;
  const path = join(assets, 'readme-hero.json');
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(path);
} finally {
  await browser.close();
  server.close();
}
