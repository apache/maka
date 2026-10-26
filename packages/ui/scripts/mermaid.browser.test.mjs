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

import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

let server, browser, url;
const diagrams = [
  'flowchart LR\nsubgraph 服务\nA[开始 Start123<br/>第二行] --> B[完成]\nend',
  'sequenceDiagram\nparticipant A as 用户\nparticipant B as 服务\nA->>B: 请求<br/>第二行\nB-->>A: 完成',
  'stateDiagram-v2\n[*] --> 等待\n等待 --> 完成\n完成 --> [*]',
  'pie title 使用情况\n"中文" : 60\n"其他" : 40',
  'timeline\ntitle 发布计划\n2026 : 开始\n2027 : 完成',
];
const fence = code => `\`\`\`mermaid\n${code}\n\`\`\``;
before(async () => {
  const root = resolve(import.meta.dirname, '../../..');
  const bundle = await build({
    stdin: { resolveDir: root, loader: 'js', contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {Theme} from '@astryxdesign/core';
      import {makaTheme} from './apps/desktop/src/renderer/astryx-theme/maka.js';
      import {Markdown} from './packages/ui/src/markdown.tsx';
      import {LocaleProvider} from './packages/ui/src/locale-context.tsx';
      import './apps/desktop/src/renderer/styles.css';
      let text='', dark=false;
      const root=createRoot(document.getElementById('root'));
      window.show=(value=text, mode=dark)=>{
        text=value; dark=mode; document.documentElement.classList.toggle('dark',dark);
        root.render(React.createElement(Theme,{theme:makaTheme,mode:dark?'dark':'light'},
          React.createElement(LocaleProvider,{locale:'en'},React.createElement(Markdown,{text,density:'default'}))));
      };
    ` },
    bundle: true, write: false, outdir: '/virtual', format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file' },
  });
  const js = bundle.outputFiles.find(f => f.path.endsWith('.js')).text;
  const css = bundle.outputFiles.find(f => f.path.endsWith('.css')).text;
  const index = await readFile(resolve(root, 'apps/desktop/src/renderer/index.html'), 'utf8');
  const csp = index.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)[1];
  server = createServer((req, res) => {
    const asset = bundle.outputFiles.find(file => req.url === '/' + file.path.split('/').at(-1));
    if (req.url === '/app.js') res.setHeader('Content-Type', 'text/javascript; charset=utf-8').end(js);
    else if (req.url === '/app.css') res.setHeader('Content-Type', 'text/css; charset=utf-8').end(css);
    else if (asset) res.setHeader('Content-Type', req.url.endsWith('.woff2') ? 'font/woff2' : req.url.endsWith('.woff') ? 'font/woff' : 'application/octet-stream').end(asset.contents);
    else res.setHeader('Content-Type', 'text/html; charset=utf-8').end(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="/app.css"></head><body style="margin:0"><main id="root" style="width:100%;max-width:900px;margin:auto"></main><script src="/app.js"></script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

async function pageFor(text) {
  const page = await browser.newPage({ viewport: { width: 900, height: 720 } });
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => console.error(error.message));
  await page.goto(url);
  await page.evaluate(text => window.show(text), text);
  return page;
}
const svg = '.maka-mermaid-svg > svg';

test('renders representative syntax, isolates SVG ids, and retains source after resource or syntax failures', async () => {
  const page = await pageFor(diagrams.map(fence).join('\n\n'));
  try {
    // Automatic rendering is limited to three diagrams per message.
    await page.locator(svg).nth(2).waitFor();
    while (await page.getByRole('button', { name: 'Render diagram', exact: true }).count()) {
      await page.getByRole('button', { name: 'Render diagram', exact: true }).first().click();
    }
    await page.locator(svg).nth(4).waitFor();
    assert.deepEqual(await page.locator(svg).evaluateAll(nodes => nodes.map(n => n.classList[1])),
      ['pele-flowchart', 'pele-sequence', 'pele-state', 'pele-pie', 'pele-timeline']);
    assert.match(await page.locator(svg).first().textContent(), /开始 Start123第二行/);
    assert.match(await page.locator(svg).first().textContent(), /服务/);
    assert.equal(await page.locator('.maka-mermaid-viewport').evaluateAll(viewports => viewports.some(viewport => {
      const controls=viewport.querySelector('.pele-zoom')?.getBoundingClientRect();
      return controls && [...viewport.querySelectorAll('svg.pele text')].some(text => {
        const box=text.getBoundingClientRect();
        return box.left<controls.right && box.right>controls.left && box.top<controls.bottom && box.bottom>controls.top;
      });
    })), false, 'built-in zoom controls must not cover diagram labels at fit size');
    await page.evaluate(text => window.show(text), [fence(diagrams[0]), fence(diagrams[0])].join('\n\n'));
    await page.waitForFunction(() => document.querySelectorAll('.maka-mermaid-svg > svg').length === 2);
    const ids = await page.locator(`${svg} [id]`).evaluateAll(nodes => nodes.map(n => n.id));
    assert.equal(new Set(ids).size, ids.length);
    const invalid = 'flowchart LR\nA[unterminated';
    const edges = 'flowchart LR\n' + Array.from({ length: 501 }, (_, i) => `a --> n${i}`).join('\n');
    const tooLong = 'flowchart LR\n' + 'x'.repeat(20000);
    await page.evaluate(text => window.show(text), [invalid, edges, tooLong].map(fence).join('\n\n'));
    if (await page.getByRole('button', { name: 'Render diagram', exact: true }).count()) await page.getByRole('button', { name: 'Render diagram', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-maka-mermaid-state="error"]').length === 3);
    assert.equal(await page.getByRole('button', { name: 'Copy code', exact: true }).count(), 3);
    assert.match(await page.locator('code').first().textContent(), /unterminated/);
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: { async writeText(value) { window.copiedSource=value; } }, configurable:true }));
    await page.getByRole('button', { name: 'Copy code', exact: true }).first().click();
    assert.equal(await page.evaluate(() => window.copiedSource), invalid);
  } finally { await page.close(); }
});

test('adapts narrow layouts, uses Pele zoom/pan, and keeps transcript height and scroll stable', async () => {
  const wide = 'flowchart LR\nA[需求分析] --> B[实现功能] --> C[代码审查] --> D[验证交付]';
  const page = await pageFor(`${fence(wide)}\n\n${'正文段落\n\n'.repeat(60)}`);
  try {
    await page.locator(svg).waitFor();
    const landscape = await page.locator(svg).getAttribute('viewBox');
    await page.setViewportSize({ width: 320, height: 720 });
    await page.waitForFunction(old => document.querySelector('.maka-mermaid-svg > svg')?.getAttribute('viewBox') !== old, landscape);
    const narrow = await page.locator(svg).getAttribute('viewBox');
    const [, , w, h] = narrow.split(' ').map(Number);
    assert.ok(h > w, 'Pele should switch a narrow LR flowchart to a vertical layout');
    await page.evaluate(() => window.scrollTo(0, 200));
    const initial = await page.evaluate(() => ({ height: document.body.scrollHeight, scroll: scrollY }));
    await page.locator('.pele-zoom-in').click();
    assert.notEqual(await page.locator(svg).getAttribute('viewBox'), narrow);
    const beforePan = await page.locator(svg).getAttribute('viewBox');
    const box = await page.locator(svg).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 25, box.y + box.height / 2 + 25); await page.mouse.up();
    assert.notEqual(await page.locator(svg).getAttribute('viewBox'), beforePan);
    await page.locator('.pele-zoom-reset').click();
    assert.equal(await page.locator(svg).getAttribute('viewBox'), narrow);
    const samples = await page.evaluate(async () => {
      const values=[];
      for(let i=0;i<30;i++) { await new Promise(requestAnimationFrame); values.push([document.body.scrollHeight,scrollY]); }
      return values;
    });
    assert.ok(samples.every(([height, scroll]) => height === initial.height && scroll === samples[0][1]), 'layout must settle without oscillation');
    await page.getByRole('button', { name: 'View diagram fullscreen' }).click();
    await page.getByRole('dialog', { name: 'Mermaid diagram' }).waitFor();
    await page.getByRole('button', { name: 'Exit diagram fullscreen' }).click();
    await page.getByRole('button', { name: 'View Mermaid source' }).click();
    assert.match(await page.locator('code').textContent(), /需求分析/);
  } finally { await page.close(); }
});

test('switches theme without rendering again and exports resolved colors and fonts in an unzoomed PNG', async () => {
  const page = await pageFor(fence(diagrams[0]));
  try {
    await page.addStyleTag({ content: '.maka-mermaid-diagram { --font-family-body: "Geist Mono Variable"; }' });
    await page.evaluate(() => document.fonts.load('16px "Geist Mono Variable"'));
    await page.locator(svg).waitFor();
    await page.evaluate(() => {
      window.originalSvg = document.querySelector('.maka-mermaid-svg > svg');
      window.originalFill = getComputedStyle(window.originalSvg.querySelector('text')).fill;
      window.clipboardImages = [];
      Object.defineProperty(navigator, 'clipboard', { value: { async write(items) {
        const blob = await items[0].getType('image/png');
        const image = await createImageBitmap(blob);
        const canvas = document.createElement('canvas'); canvas.width=image.width; canvas.height=image.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image,0,0);
        const pixels = ctx.getImageData(0,0,canvas.width,canvas.height).data;
        const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))].join(',');
        window.clipboardImages.push({ width:image.width, height:image.height, corner:[...pixels.slice(0,4)], colors:new Set(Array.from({length:pixels.length/4},(_,i)=>pixels.slice(i*4,i*4+3).join(','))).size, fingerprint });
      } }, configurable:true });
      const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
      Object.defineProperty(HTMLImageElement.prototype,'src',{ ...src, set(value) { window.exportedSvg = value; src.set.call(this,value); } });
    });
    await page.getByRole('button', { name: 'Copy diagram', exact: true }).click();
    await page.waitForFunction(() => window.clipboardImages.length === 1);
    await page.evaluate(() => window.show(undefined, true));
    await page.waitForFunction(() => getComputedStyle(window.originalSvg.querySelector('text')).fill !== window.originalFill);
    assert.equal(await page.evaluate(() => window.originalSvg === document.querySelector('.maka-mermaid-svg > svg')), true);
    await page.locator('.pele-zoom-in').click();
    await page.getByRole('button', { name: 'Copy diagram', exact: true }).click();
    await page.waitForFunction(() => window.clipboardImages.length === 2);
    const result = await page.evaluate(async () => {
      const exported = new DOMParser().parseFromString(decodeURIComponent(window.exportedSvg.split(',')[1]),'image/svg+xml');
      const text = exported.querySelector('text');
      const live = document.querySelector('.maka-mermaid-svg text');
      const result = { images:window.clipboardImages, fill:text.style.fill, font:text.style.fontFamily,
        expectedFill:getComputedStyle(live).fill, expectedFont:getComputedStyle(live).fontFamily,
        viewBox:exported.documentElement.getAttribute('viewBox'), embeddedFonts:exported.querySelector('style')?.textContent };
      for (const style of exported.querySelectorAll('style')) if (style.textContent.includes('@font-face')) style.remove();
      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(exported))}`;
      await image.decode();
      const canvas = document.createElement('canvas'); canvas.width=image.naturalWidth; canvas.height=image.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle=getComputedStyle(document.querySelector('.maka-mermaid-diagram')).backgroundColor;
      ctx.fillRect(0,0,canvas.width,canvas.height); ctx.drawImage(image,0,0);
      const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      result.withoutFontsFingerprint=[...new Uint8Array(await crypto.subtle.digest('SHA-256',pixels))].join(',');
      return result;
    });
    assert.equal(result.fill, result.expectedFill);
    assert.equal(result.font, result.expectedFont);
    assert.match(result.embeddedFonts ?? '', /@font-face.*data:font\//s, 'packaged web fonts must travel with the standalone image');
    assert.notEqual(result.images[1].fingerprint, result.withoutFontsFingerprint, 'embedded fonts must affect actual exported glyph pixels');
    assert.notDeepEqual(result.images[0].corner, result.images[1].corner);
    assert.ok(result.images.every(image => image.colors > 10 && image.corner[3] === 255), 'PNG must contain shapes/text on an opaque theme background');
    assert.equal(result.images[0].width, result.images[1].width, 'zoom must not crop export');
    assert.match(result.viewBox, /^0 0 /);
  } finally { await page.close(); }
});
