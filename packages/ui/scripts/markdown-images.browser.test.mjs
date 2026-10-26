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

// Chromium owns image requests and CSP enforcement; fake DOM tests cannot
// detect an allowed Markdown URL that the desktop policy blocks.
// Run after building @maka/ui: node --test packages/ui/scripts/markdown-images.browser.test.mjs
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { antigravitySvg } from './fixtures/antigravity-core.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
let appServer, imageServer, browser, appUrl, imageUrl;
let requests = [], failedOnce = false;
before(async () => {
  imageServer = createServer((req, res) => {
    requests.push({ path: req.url, referer: req.headers.referer });
    if (req.url === '/retry.png' && !failedOnce) {
      failedOnce = true;
      res.writeHead(404).end();
    } else {
      res.setHeader('Content-Type', 'image/png');
      res.end(png);
    }
  });
  await new Promise(resolve => imageServer.listen(0, '127.0.0.1', resolve));
  imageUrl = `http://127.0.0.1:${imageServer.address().port}`;
  const fence = (language, code) => ['```' + language, code, '```'].join('\n');
  const tinySvg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="blue"/></svg>';
  const nestedSvg = [fence('svg', tinySvg), fence('xml', tinySvg), fence('svg', tinySvg), fence('xml', tinySvg)].join('\n\n');
  const destinations = {
    'svg-budget-update': fence('svg', tinySvg),
    'xml-antigravity-streaming': fence('xml', antigravitySvg),
    'xml-ordinary': fence('xml', '<document><title>Keep XML source</title></document>'),
    'svg-only-quoted-budget': Array.from({length:4}, () => fence('svg', tinySvg)).join('\n\n').split('\n').map(line => '> ' + line).join('\n'),
    'svg-quoted-budget': nestedSvg.split('\n').map(line => '> ' + line).join('\n'),
    'svg-list-budget': nestedSvg.split('\n\n').map(fence => '- ' + fence.replaceAll('\n', '\n  ')).join('\n'),
    'svg-saved': '![SVG](maka://runtime/attachments/svg-image)',
    "svg-fence": "```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"240\" height=\"120\" viewBox=\"0 0 240 120\" onload=\"window.svgExecuted=true\"><script>window.svgExecuted=true</script><rect width=\"240\" height=\"120\" rx=\"12\" fill=\"#4355d9\"/><text x=\"20\" y=\"70\" fill=\"white\" font-size=\"28\">Maka SVG</text></svg>\n```",
    "svg-fence-offscreen": "```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"240\" height=\"120\" viewBox=\"0 0 240 120\" onload=\"window.svgExecuted=true\"><script>window.svgExecuted=true</script><rect width=\"240\" height=\"120\" rx=\"12\" fill=\"#4355d9\"/><text x=\"20\" y=\"70\" fill=\"white\" font-size=\"28\">Maka SVG</text></svg>\n```",
    "svg-fence-streaming": "```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"240\" height=\"120\" viewBox=\"0 0 240 120\" onload=\"window.svgExecuted=true\"><script>window.svgExecuted=true</script><rect width=\"240\" height=\"120\" rx=\"12\" fill=\"#4355d9\"/><text x=\"20\" y=\"70\" fill=\"white\" font-size=\"28\">Maka SVG</text></svg>\n```",

    'links-formats': [
      `![Screenshot](${imageUrl}/image.png)`,
      `![Title](${imageUrl}/title.png "Screenshot title")`,
      `![Angle](<${imageUrl}/angle.png>)`,
      '![Escaped](' + imageUrl + String.raw`/a\(1\).png)`,
      '![Reference][picture]',
      `[picture]: <${imageUrl}/reference.png>`,
      `Build ![Badge](${imageUrl}/badge.png) passing.`,
      `![](${imageUrl}/empty.png)`,
      '![Local](/tmp/private.png)',
      '`![Example](https://example.com/code.png)`',
    ].join('\n\n'),
    'links-redacted': `![Signed](${imageUrl}/image.png?token=reasoning-secret)\n\n![Blocked](javascript:alert)`,
    'links-streaming': `![Streaming](${imageUrl}/stream`,
    'angle-saved': '![Screenshot](</tmp/my image.png>)',
    'title-saved': `![Screenshot](${imageUrl}/image.png "Screenshot title")`,
    'escaped-saved': String.raw`![Screenshot](/tmp/a\(1\).png)`,
    'reference-saved': '![Screenshot][picture]\n\n[picture]: </tmp/my "image".png>',
    'attachment-title': '![Screenshot](maka://runtime/attachments/image-1 "Screenshot title")',
    'streaming-angle-race': '![Screenshot](</tmp/my image.png>)',
    'signed-remote': `![Screenshot](${imageUrl}/image.png?token=remote-secret)`,
    'signed-inline': `Build ![Badge](${imageUrl}/image.png?token=inline-secret) passing.`,
    'signed-failed': `![Screenshot](${imageUrl}/image.png?token=failed-secret)`,
    'signed-preview': `![Screenshot](${imageUrl}/image.png?token=preview-secret)`,
  };
  destinations['xml-untrusted'] = destinations['svg-fence'].replace('```svg', '```xml');
  const canonicalSources = {
    'angle-saved': ['/tmp/my image.png'],
    'title-saved': [`${imageUrl}/image.png`],
    'escaped-saved': ['/tmp/a(1).png'],
    'reference-saved': ['/tmp/my "image".png'],
    'streaming-angle-race': ['/tmp/my image.png'],
  };
  const bundle = await build({
    stdin: { contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {Theme} from '@astryxdesign/core';
      import {makaTheme} from './apps/desktop/src/renderer/astryx-theme/maka.js';
      import {Markdown} from './packages/ui/dist/markdown.js';
      import {LocaleProvider} from './packages/ui/dist/locale-context.js';
      import {ImageDeliveryProvider, ImageMessageProvider} from './packages/ui/dist/image-delivery.js';
      import {SessionAttachmentProvider} from './packages/ui/dist/attachment-image.js';
      import './apps/desktop/src/renderer/styles.css';
      const mode=new URLSearchParams(location.search).get('case') || 'remote';
      const destinations=${JSON.stringify(destinations)};
      const canonicalSources=${JSON.stringify(canonicalSources)};
      let reads=0; const captured=new Map(); window.imageReads=0; window.deliveryQueries=0; window.deliverySources=[]; window.deliveryReady=false; window.deliveryRetries=0;
      const race=mode.endsWith('-race');
      let messageId='message';
      let text=destinations[mode] ?? (mode==='attachment' ? '![Screenshot](maka://runtime/attachments/image-1)' :
        mode==='local' || mode==='local-saved' || race ? '![Screenshot](/tmp/private.png)' :
        '![Screenshot](${imageUrl}/'+(mode==='retry' ? 'retry.png' : 'image.png')+')');
      const root=createRoot(document.getElementById('root'));
      const readBytes=async(_session,artifactId)=>{
        if(mode==='svg-saved') { window.imageReads++; return {ok:true,mimeType:'image/svg+xml',base64:'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNDAiIGhlaWdodD0iMTIwIiB2aWV3Qm94PSIwIDAgMjQwIDEyMCIgb25sb2FkPSJ3aW5kb3cuc3ZnRXhlY3V0ZWQ9dHJ1ZSI+PHNjcmlwdD53aW5kb3cuc3ZnRXhlY3V0ZWQ9dHJ1ZTwvc2NyaXB0PjxyZWN0IHdpZHRoPSIyNDAiIGhlaWdodD0iMTIwIiByeD0iMTIiIGZpbGw9IiM0MzU1ZDkiLz48dGV4dCB4PSIyMCIgeT0iNzAiIGZpbGw9IndoaXRlIiBmb250LXNpemU9IjI4Ij5NYWthIFNWRzwvdGV4dD48L3N2Zz4='}; }
        if(captured.has(artifactId)) return captured.get(artifactId);
        reads++; window.imageReads=reads; return (mode==='attachment' || mode==='read-retry-saved') && reads===1 ? {ok:false,reason:'read_failed'} :
          {ok:true,base64:mode.endsWith('corrupt-saved') && reads===1 ? 'iVBORw0KGgo=' : '${png.toString('base64')}',mimeType:'image/png'};
      };
      const preview=mode==='preview' || mode==='signed-preview' || mode==='local';
      const seeded=mode.endsWith('saved') || mode.endsWith('saving') || race;
      const resolveDelivery=preview ? undefined : async(_session,request)=>{
        window.deliveryQueries++;
        window.deliverySource=request.source;
        window.deliverySources.push(request.source);
        if(canonicalSources[mode] && !canonicalSources[mode].includes(request.source)) return {status:'unavailable'};
        if(request.retry) window.deliveryRetries++;
        if(mode==='privacy') return {status:'failed',reason:'not_allowed'};
        if(mode==='signed-failed') return {status:'failed',reason:'download_failed'};
        if(!seeded) {
          if(!request.loadRemote) return {status:'requires_confirmation'};
          const response=await fetch('/capture?source='+encodeURIComponent(request.source));
          const payload=await response.json();
          if(!payload.ok) return {status:'failed',reason:'download_failed'};
          captured.set(request.source,payload);
          return {status:'ready',artifactId:request.source};
        }
        if(race) return window.deliveryReady ? {status:'ready',artifactId:'saved-image'} : {status:'unavailable'};
        await new Promise(resolve=>setTimeout(resolve,100));
        return mode.endsWith('saving') && window.deliveryQueries===1 ? {status:'pending'} : {status:'ready',artifactId:'saved-image'};
      };
      const markdown=(streaming)=>React.createElement(ImageMessageProvider,{identity:{turnId:'turn',messageId},streaming},
        React.createElement(Markdown,{text,streaming,settledText:race ? text : undefined,density:'compact',imageDisplay:mode.startsWith('links-') ? 'link' : undefined}));
      const render=(streaming=race || mode==='links-streaming' || mode==='svg-fence-streaming' || mode==='xml-antigravity-streaming')=>root.render(
        React.createElement(Theme,{theme:makaTheme,mode:'light'},
          React.createElement(LocaleProvider,{locale:'en'},
            React.createElement(SessionAttachmentProvider,{sessionId:'session',readBytes},
              React.createElement(ImageDeliveryProvider,{sessionId:'session',resolve:resolveDelivery},
              React.createElement('div',{style:(mode==='offscreen' || mode==='svg-fence-offscreen') ? {paddingTop:'2500px'} : {}},
                markdown(streaming)))))));
      window.nextMessage=()=>{messageId='next-message'; render(false);};
      window.finishStream=()=>render(false);
      window.replaceText=value=>{text=value; render(false);};
      window.appendText=value=>{text+=value; render(true);};
      render();
    `, resolveDir: root, loader: 'js' },
    bundle: true, write: false, outdir: '/virtual', format: 'iife',
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text;
  const index = await readFile(new URL('../../../apps/desktop/src/renderer/index.html', import.meta.url), 'utf8');
  const csp = index.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)[1];
  appServer = createServer((req, res) => {
    if (req.url.startsWith('/capture?')) {
      const source=new URL(req.url, appUrl).searchParams.get('source');
      void fetch(source).then(async response=> {
        const payload=response.ok ? {ok:true,base64:Buffer.from(await response.arrayBuffer()).toString('base64'),mimeType:'image/png'} : {ok:false};
        res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(payload));
      }).catch(()=>res.end(JSON.stringify({ok:false}))); return;
    }
    if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(js); }
    else if (req.url === '/app.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); }
    else {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><html><head><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="/app.css"></head><body><main id="root"></main><script src="/app.js"></script></body></html>`);
    }
  });
  await new Promise(resolve => appServer.listen(0, '127.0.0.1', resolve));
  appUrl = `http://127.0.0.1:${appServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
});

after(async () => {
  await browser?.close();
  for (const server of [appServer, imageServer]) if (server) await new Promise(resolve => server.close(resolve));
});

async function pageFor(scenario) {
  const page = await browser.newPage({ viewport: { width: 720, height: 600 } });
  page.setDefaultTimeout(5000);
  await page.goto(`${appUrl}/?case=${scenario}`, { waitUntil: 'domcontentloaded' });
  return page;
}

async function loaded(page) {
  await page.waitForFunction(() => [...document.images].some(image => image.naturalWidth === 1));
}

test('image links preserve Markdown destinations without loading image or attachment bytes', async () => {
  requests = [];
  const page = await pageFor('links-formats');
  try {
    await page.getByRole('link', {name:/^Screenshot/}).waitFor();
    assert.equal(await page.getByRole('link', {name:/^Screenshot/}).getAttribute('href'), `${imageUrl}/image.png`);
    assert.equal(await page.getByRole('link', {name:/^Title/}).getAttribute('href'), `${imageUrl}/title.png`);
    assert.equal(await page.getByRole('link', {name:/^Angle/}).getAttribute('href'), `${imageUrl}/angle.png`);
    assert.equal(await page.getByRole('link', {name:/^Escaped/}).getAttribute('href'), `${imageUrl}/a(1).png`);
    assert.equal(await page.getByRole('link', {name:/^Reference/}).getAttribute('href'), `${imageUrl}/reference.png`);
    assert.equal(await page.getByRole('link', {name:/^Badge/}).getAttribute('href'), `${imageUrl}/badge.png`);
    assert.equal(await page.locator('a').filter({hasText:`${imageUrl}/empty.png`}).getAttribute('href'), `${imageUrl}/empty.png`);
    assert.equal(await page.locator('a a').count(), 0);
    assert.equal(await page.getByRole('link', {name:'Local', exact:true}).count(), 0);
    assert.equal(await page.locator('code').innerText(), '![Example](https://example.com/code.png)');
    assert.equal(await page.locator('img, .maka-markdown-image-resource').count(), 0);
    assert.deepEqual(await page.evaluate(() => [window.deliveryQueries, window.imageReads]), [0, 0]);
    assert.deepEqual(requests, []);
  } finally { await page.close(); }
});

test('image links do not expose signed destinations or enable unsafe schemes', async () => {
  requests = [];
  const page = await pageFor('links-redacted');
  try {
    await page.locator('[data-maka-contract="markdown"]').waitFor();
    assert.equal(await page.locator('a, img, .maka-markdown-image-resource').count(), 0);
    assert.doesNotMatch(await page.locator('#root').innerHTML(), /reasoning-secret/);
    assert.deepEqual(await page.evaluate(() => [window.deliveryQueries, window.imageReads]), [0, 0]);
    assert.deepEqual(requests, []);
  } finally { await page.close(); }
});

test('streaming reasoning completes image syntax as a link without fetching it', async () => {
  requests = [];
  const page = await pageFor('links-streaming');
  try {
    await page.waitForFunction(() => typeof window.appendText === 'function');
    await page.evaluate(() => window.appendText('.png)'));
    await page.getByRole('link', {name:/^Streaming/}).waitFor();
    await page.evaluate(() => window.finishStream());
    assert.equal(await page.getByRole('link', {name:/^Streaming/}).getAttribute('href'), `${imageUrl}/stream.png`);
    assert.equal(await page.locator('img, .maka-markdown-image-resource').count(), 0);
    assert.deepEqual(await page.evaluate(() => [window.deliveryQueries, window.imageReads]), [0, 0]);
    assert.deepEqual(requests, []);
  } finally { await page.close(); }
});

test('remote images load automatically as Host-owned bytes with a separate identity per message', async () => {
  requests = [];
  const page = await pageFor('remote');
  try {
    await loaded(page);
    assert.equal(await page.getByRole('button', { name: 'Load image', exact: true }).count(), 0);
    assert.deepEqual(requests, [{ path: '/image.png', referer: undefined }]);
    assert.match(await page.locator('img').getAttribute('src'), /^data:/);
    await page.evaluate(() => window.nextMessage());
    await page.waitForFunction(() => window.deliveryQueries >= 2);
    await loaded(page);
    assert.equal(requests.length, 2);
  } finally { await page.close(); }
});

for (const scenario of ['preview', 'signed-preview']) {
  test(`${scenario}: untrusted Markdown cannot load remote images or signed tracking URLs`, async () => {
    requests = [];
    const page = await pageFor(scenario);
    try {
      if(scenario==='signed-preview') {
        await page.locator('[data-maka-contract="markdown"]').waitFor();
        assert.equal(await page.getByText('Open in browser', {exact:true}).count(), 0);
      } else {
        await page.getByText('Remote images cannot be loaded here. You can open this image in your browser.', {exact:true}).waitFor();
        await page.getByText('Open in browser', {exact:true}).waitFor();
      }
      assert.deepEqual(requests, []);
      assert.equal(await page.locator('img').count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Load image', exact: true }).count(), 0);
      assert.ok(!(await page.locator('body').innerText()).includes('preview-secret'));
      if (scenario === 'preview') {
        // Prove the production CSP blocks a bypass of the Markdown component too.
        await page.evaluate(url => {
          const img=document.createElement('img'); img.src=url; document.body.append(img);
          return new Promise(resolve=> { img.onerror=resolve; img.onload=()=>resolve(); });
        }, `${imageUrl}/blocked.png`);
        assert.deepEqual(requests, []);
      }
    } finally { await page.close(); }
  });
}

for (const scenario of ['signed-remote', 'signed-inline', 'signed-failed']) {
  test(`${scenario}: hidden destinations provide no network actions, including failure and inline states`, async () => {
    requests = [];
    const page = await pageFor(scenario);
    try {
      await page.locator('[data-maka-contract="markdown"]').waitFor();
      assert.equal(await page.getByRole('button', {name: 'Load image', exact: true}).count(), 0);
      assert.equal(await page.getByRole('button', {name: 'Retry', exact: true}).count(), 0);
      assert.equal(await page.getByText('Open in browser', {exact: true}).count(), 0);
      assert.equal(await page.locator('a[href*="token="]').count(), 0);
      assert.equal(await page.locator('img').count(), 0);
      assert.doesNotMatch(await page.locator('body').innerText(), /remote-secret|inline-secret|failed-secret/);
      assert.deepEqual(requests, []);
    } finally { await page.close(); }
  });
}

test('application privacy policy prevents automatic image loading and can be rechecked', async () => {
  requests = [];
  const page = await pageFor('privacy');
  try {
    await page.getByText('Image not saved: permissions, network settings, or the source address block loading.', {exact: true}).waitFor();
    assert.equal(await page.getByRole('button', {name: 'Load image', exact: true}).count(), 0);
    await page.getByRole('button', {name: 'Retry', exact: true}).click();
    await page.getByText('Image not saved: permissions, network settings, or the source address block loading.', {exact: true}).waitFor();
    await page.getByText('Open in browser', {exact: true}).waitFor();
    assert.deepEqual(requests, []);
  } finally { await page.close(); }
});

test('failed remote image has a working retry control instead of a broken image icon', async () => {
  failedOnce = false;
  const page = await pageFor('retry');
  try {
    await page.getByText('Image not saved: download failed. Try again.').waitFor();
    assert.equal(await page.locator('img').count(), 0);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await loaded(page);
  } finally { await page.close(); }
});

test('attachment read failure recovers in place, and local paths explain how to provide an image', async () => {
  const page = await pageFor('attachment');
  try {
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await loaded(page);
    assert.match(await page.locator('img').getAttribute('src'), /^data:image\/png;base64,/);
    await page.goto(`${appUrl}/?case=local`);
    await page.getByText('This image address cannot be displayed here.').waitFor();
    assert.equal(await page.locator('img').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Load image' }).count(), 0);
  } finally { await page.close(); }
});

for (const scenario of ['corrupt-saved']) {
  test(`${scenario}: a saved image decode failure retries archived bytes without touching its source`, async () => {
    requests = [];
    const page = await pageFor(scenario);
    try {
      await page.getByText('Could not load the image. Try again.').waitFor();
      assert.equal(await page.evaluate(() => window.imageReads), 1);
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await page.waitForFunction(() => [...document.images].some(img => img.src.startsWith('data:image/png;') && img.naturalWidth === 1));
      assert.equal(await page.evaluate(() => window.deliveryRetries), 0);
      assert.equal(await page.evaluate(() => window.deliveryQueries), 1);
      assert.equal(await page.evaluate(() => window.imageReads), 2);
      assert.deepEqual(requests, []);
    } finally { await page.close(); }
  });

}

test('a transient saved attachment read retries its bytes without invalidating archival or touching origin', async () => {
  requests = [];
  const page = await pageFor('read-retry-saved');
  try {
    await page.getByText('Could not load the image. Try again.').waitFor();
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await loaded(page);
    assert.equal(await page.evaluate(() => window.deliveryRetries), 0);
    assert.equal(await page.evaluate(() => window.deliveryQueries), 1);
    assert.equal(await page.evaluate(() => window.imageReads), 2);
    assert.deepEqual(requests, []);
  } finally { await page.close(); }
});

test('offscreen image performs no image request until it approaches the viewport', async () => {
  requests = [];
  const page = await pageFor('offscreen');
  try {
    // Let React effects and the initial IntersectionObserver callback complete.
    await page.getByText('Loading image…').waitFor();
    assert.deepEqual(requests, []);
    assert.equal(await page.locator('img').count(), 0);
    await page.locator('[data-maka-image-state]').scrollIntoViewIfNeeded();
    await loaded(page);
    assert.deepEqual(requests, [{ path: '/image.png', referer: undefined }]);
  } finally { await page.close(); }
});

test('a pending archive stays a placeholder until saved bytes are available', async () => {
  requests = [];
  const page = await pageFor('saving');
  try {
    await page.getByText('Loading image…', { exact: true }).waitFor();
    assert.deepEqual(requests, []);
    assert.equal(await page.locator('img').count(), 0);
    await page.waitForFunction(() => [...document.images].some(img=>img.src.startsWith('data:image/png;') && img.naturalWidth===1));
    await page.getByText('Loading image…', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('status').filter({ hasText: /\S/ }).count(), 0);
    assert.equal(await page.evaluate(() => window.deliveryQueries), 2);
    assert.equal(requests.length, 0);
  } finally { await page.close(); }
});

for (const scenario of ['streaming-race', 'settled-race', 'streaming-angle-race']) {
  test(`${scenario}: an unavailable live source recovers in place once Host archival completes`, async () => {
    const page = await pageFor(scenario);
    try {
      await page.waitForFunction(() => window.deliveryQueries === 1);
      if (scenario === 'settled-race') {
        await page.evaluate(() => window.finishStream());
        await page.waitForFunction(() => window.deliveryQueries >= 2);
      }
      await page.evaluate(() => { window.deliveryReady = true; });
      await page.waitForFunction(() => [...document.images].some(image => image.src.startsWith('data:') && image.naturalWidth === 1));
      assert.equal(await page.evaluate(() => window.imageReads), 1);
      assert.match(await page.locator('img').getAttribute('src'), /^data:image\/png;base64,/);
      assert.equal(await page.locator('img').count(), 1);
    } finally { await page.close(); }
  });
}

for (const scenario of ['angle-saved', 'title-saved', 'escaped-saved', 'reference-saved', 'attachment-title']) {
  test(`${scenario}: standard Markdown destinations resolve to saved bytes without origin requests`, async () => {
    requests = [];
    const page = await pageFor(scenario);
    try {
      await loaded(page);
      assert.match(await page.locator('img').getAttribute('src'), /^data:image\/png;base64,/);
      assert.deepEqual(requests, []);
      assert.equal(await page.evaluate(() => window.imageReads), 1);
      if (scenario !== 'attachment-title') {
        assert.equal(await page.evaluate(() => window.deliveryQueries), 1);
      }
    } finally { await page.close(); }
  });
}


for (const mode of ['svg-saved', 'svg-fence', 'xml-untrusted']) {
  test(`SVG ${mode} displays through static image context and strips executable content`, async () => {
    const page = await pageFor(mode);
    try {
      await page.waitForFunction(() => { const img = document.querySelector('#root img'); return img?.complete && img.naturalWidth === 240; });
      assert.equal(await page.evaluate(() => window.svgExecuted), undefined);
      const source = await page.locator('#root img').getAttribute('src');
      assert.doesNotMatch(decodeURIComponent(source), /<script|onload/);
      assert.equal(await page.locator('#root svg script').count(), 0);
      if (mode === 'svg-fence') {
        await page.getByRole('button', { name: 'View source', exact: true }).click();
        assert.equal(await page.locator('#root img').count(), 0);
        await page.getByRole('button', { name: 'Preview SVG', exact: true }).click();
        await page.locator('#root img').waitFor();
        assert.equal(await page.getByRole('link', { name: 'Download SVG' }).getAttribute('download'), 'image.svg');
      }
    } finally { await page.close(); }
  });
}

test('SVG code preview waits for settlement and viewport visibility', async () => {
  const streaming = await pageFor('svg-fence-streaming');
  const offscreen = await pageFor('svg-fence-offscreen');
  try {
    await streaming.locator('[data-maka-contract="markdown"]').waitFor();
    assert.equal(await streaming.locator('[data-kind="svg-preview"]').count(), 0);
    await streaming.evaluate(() => window.finishStream());
    await streaming.locator('[data-kind="svg-preview"] img').waitFor();
    await offscreen.locator('[data-kind="svg-preview"]').waitFor({state:'attached'});
    assert.equal(await offscreen.locator('#root img').count(), 0);
    await offscreen.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await offscreen.locator('#root img').waitFor();
  } finally { await streaming.close(); await offscreen.close(); }
});


test('Antigravity XML SVG replies preview after settlement with source and sanitized download', async () => {
  const page = await pageFor('xml-antigravity-streaming');
  try {
    await page.locator('[data-maka-code-layout]').waitFor();
    assert.equal(await page.locator('[data-kind="svg-preview"]').count(), 0);
    await page.evaluate(() => window.finishStream());
    await page.waitForFunction(() => { const img = document.querySelector('[data-kind="svg-preview"] img'); return img?.complete && img.naturalWidth > 0; });
    const source = await page.locator('[data-kind="svg-preview"] img').getAttribute('src');
    const svg = decodeURIComponent(source);
    assert.match(svg, /ANTIGRAVITY/);
    if (process.env.MAKA_MEDIA_SCREENSHOT_PATH) await page.screenshot({path:process.env.MAKA_MEDIA_SCREENSHOT_PATH,fullPage:true});
    assert.doesNotMatch(svg, /<filter|feGaussianBlur|\bfilter=/);
    await page.getByRole('button', {name:'View source', exact:true}).click();
    assert.equal(await page.locator('[data-kind="svg-preview"] img').count(), 0);
    await page.getByRole('button', {name:'Preview SVG', exact:true}).click();
    await page.locator('[data-kind="svg-preview"] img').waitFor();
    assert.equal(await page.getByRole('link', {name:'Download SVG'}).getAttribute('href'), source);
  } finally { await page.close(); }
});

for (const mode of ['svg-only-quoted-budget', 'svg-quoted-budget', 'svg-list-budget']) {
  test(`${mode}: SVG and XML share the document preview budget inside containers`, async () => {
    const page = await pageFor(mode);
    try {
      await page.waitForFunction(() => document.querySelectorAll('[data-kind="svg-preview"]').length === 4);
      await page.waitForFunction(() => [...document.querySelectorAll('[data-kind="svg-preview"] img')].filter(img => img.complete && img.naturalWidth > 0).length === 3);
      const deferred = page.locator('[data-kind="svg-preview"]').nth(3);
      assert.equal(await deferred.locator('img').count(), 0);
      await deferred.getByRole('button', {name:'Preview SVG', exact:true}).click();
      await deferred.locator('img').waitFor();
    } finally { await page.close(); }
  });
}

test('ordinary XML stays source code', async () => {
  const page = await pageFor('xml-ordinary');
  try {
    await page.locator('[data-maka-code-layout]').waitFor();
    assert.equal(await page.locator('[data-kind="svg-preview"]').count(), 0);
    assert.equal(await page.locator('#root img').count(), 0);
  } finally { await page.close(); }
});

test('SVG input complexity falls back to source and a later valid preview recovers', async () => {
  const page = await pageFor('svg-budget-update');
  const dense = '<svg>' + '<a/>'.repeat(16000) + '</svg>';
  assert.ok(dense.length < 64 * 1024, 'exercise the automatic preview path');
  const replace = code => page.evaluate(value => window.replaceText(value), ['```svg', code, '```'].join('\n'));
  try {
    await page.locator('[data-kind="svg-preview"] img').waitFor();
    await replace(dense);
    await page.getByRole('status').filter({hasText: 'Could not load the image. Try again.'}).waitFor({timeout: 5000});
    assert.equal(await page.locator('[data-kind="svg-preview"] img').count(), 0);
    assert.equal(await page.getByRole('link', {name:'Download SVG'}).count(), 0);
    assert.ok((await page.locator('[data-kind="svg-preview"]').textContent()).includes(dense), 'Original SVG source remains available');
    assert.ok(await page.locator('[data-kind="svg-preview"] pre span').count() < 100, 'Large fallback source must not expand into thousands of syntax nodes');
    await replace('<svg width="40" height="20"><rect width="40" height="20" fill="blue"/></svg>');
    await page.waitForFunction(() => document.querySelector('[data-kind="svg-preview"] img')?.naturalWidth === 40);
    assert.equal(await page.getByRole('status').filter({hasText: 'Could not load the image. Try again.'}).count(), 0);
  } finally { await page.close(); }
});


test('a changed SVG block rechecks its budget and does not reuse manual admission', async () => {
  const page = await pageFor('svg-budget-update');
  const oversized = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20">' + ' '.repeat(65536) + '<rect width="40" height="20" fill="blue"/></svg>';
  try {
    await page.locator('[data-kind="svg-preview"] img').waitFor();
    const replace = code => page.evaluate(value => window.replaceText(value), ['```xml', code, '```'].join('\n'));
    await replace(oversized);
    const preview = page.getByRole('button', {name:'Preview SVG', exact:true});
    await preview.waitFor();
    assert.equal(await page.locator('[data-kind="svg-preview"] img').count(), 0);
    await preview.click();
    await page.locator('[data-kind="svg-preview"] img').waitFor();
    await replace(oversized.replace('blue', 'red'));
    await preview.waitFor();
    assert.equal(await page.locator('[data-kind="svg-preview"] img').count(), 0);
  } finally { await page.close(); }
});
