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
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
const badge = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAFAAAAAUCAYAAAAa2LrXAAAATklEQVR4nO3OsQ0AIAzAsJ7O5/QIhsgSg3fPnLnfgzygywO6PKDLA7o8oMsDujygywO6PKDLA7o8oMsDujygywO6PKDLA7o8oMsDujyAW5KWWkgoVkkSAAAAAElFTkSuQmCC', 'base64');
const dimensions = [
  ['small', 80, 20], ['square', 1000, 1000], ['landscape', 1600, 900],
  ['portrait', 900, 1600], ['panorama', 2000, 100], ['tall', 100, 2000], ['pixel', 1, 1],
];
let appServer, imageServer, browser, appUrl, imageUrl;
let requests = [], failedOnce = false;
let releaseImage;
let releaseAttachment;
const delayedImage = new Promise(resolve => { releaseImage = resolve; });
const delayedAttachment = new Promise(resolve => { releaseAttachment = resolve; });

// Keep the screenshot's original dimensions without committing evidence images.
function screenshotFixture(width = 900, height = 730) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; // 8-bit RGB.
  const stride = 1 + width * 3;
  const pixels = Buffer.alloc(stride * height, 220);
  for (let row = 0; row < height; row++) {
    pixels.fill(row < height / 2 ? 120 : 220, row * stride, (row + 1) * stride);
    pixels[row * stride] = 0; // PNG filter: None.
  }
  const chunk = (type, data) => {
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length, 0); result.write(type, 4, 'ascii');
    data.copy(result, 8);
    result.writeUInt32BE(crc32(result.subarray(4, data.length + 8)), data.length + 8);
    return result;
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

before(async () => {
  const screenshot = screenshotFixture();
  const sizedImages = new Map(dimensions.map(([name, width, height]) => [`/${name}.png`, screenshotFixture(width, height)]));
  imageServer = createServer((req, res) => {
    requests.push({ path: req.url, referer: req.headers.referer });
    if (sizedImages.has(req.url)) {
      res.setHeader('Content-Type', 'image/png'); res.end(sizedImages.get(req.url)); return;
    }
    if (req.url === '/delayed.png') {
      void delayedImage.then(() => { res.setHeader('Content-Type', 'image/png'); res.end(screenshot); });
      return;
    }
    if (req.url === '/screenshot.png') {
      res.setHeader('Content-Type', 'image/png'); res.end(screenshot); return;
    }
    if (req.url === '/badge.png') {
      res.setHeader('Content-Type', 'image/png'); res.end(badge); return;
    }
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
  const destinations = {
    ...Object.fromEntries(dimensions.map(([name]) => [`size-${name}`, `![Screenshot](${imageUrl}/${name}.png)`])),
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
    'badge-remote': `Build ![Badge](${imageUrl}/badge.png) passing.`,
    'badge-saved': `Build ![Badge](${imageUrl}/badge.png) passing.`,
    'badge-saving': `Build ![Badge](${imageUrl}/badge.png) passing.`,
    'badge-list': `- Build ![Badge](${imageUrl}/badge.png) passing.`,
    'badge-table': `| Build | Result |\n| --- | --- |\n| ![Badge](${imageUrl}/badge.png) | passing |`,
    'badge-strip': `![Badge](${imageUrl}/badge.png) ![Badge](${imageUrl}/badge.png)`,
    'layout-main': `## Image delivery\n\nBuild ![Badge](${imageUrl}/badge.png) passing.\n\n![Screenshot](${imageUrl}/screenshot.png)\n\nFollowing paragraph.`,
    'layout-side': `## Image delivery\n\nBuild ![Badge](${imageUrl}/badge.png) passing.\n\n![Screenshot](${imageUrl}/screenshot.png)\n\nFollowing paragraph.`,
    'screenshot-saved': '![Screenshot](/tmp/screenshot.png)',
    'angle-saved': '![Screenshot](</tmp/my image.png>)',
    'title-saved': `![Screenshot](${imageUrl}/image.png "Screenshot title")`,
    'escaped-saved': String.raw`![Screenshot](/tmp/a\(1\).png)`,
    'reference-saved': '![Screenshot][picture]\n\n[picture]: </tmp/my "image".png>',
    'attachment-title': '![Screenshot](maka://runtime/attachments/image-1 "Screenshot title")',
    'geometry-remote': `![Screenshot](${imageUrl}/delayed.png)\n\nFollowing paragraph`,
    'geometry-saved': '![Screenshot](/tmp/private.png)\n\nFollowing paragraph',
    'streaming-angle-race': '![Screenshot](</tmp/my image.png>)',
    'signed-saved': `![Screenshot](${imageUrl}/image.png?token=first-secret)`,
    'signature-saved': `![Screenshot](${imageUrl}/image.png?signature=second-secret&expires=123)`,
    'hash-saved': `![Screenshot](/tmp/${'a'.repeat(48)}.png)`,
    'secret-reference-saved': `![Screenshot][picture]\n\n[picture]: ${imageUrl}/image.png?token=reference-secret`,
    'signed-streaming-race': `![Screenshot](${imageUrl}/image.png?token=stream-secret)`,
    'signed-corrupt-saved': `![Screenshot](${imageUrl}/image.png?token=corrupt-secret)`,
    'signed-remote': `![Screenshot](${imageUrl}/image.png?token=remote-secret)`,
    'signed-inline': `Build ![Badge](${imageUrl}/image.png?token=inline-secret) passing.`,
    'signed-failed': `![Screenshot](${imageUrl}/image.png?token=failed-secret)`,
    'secret-alt': `![https://example.invalid/?token=alt-secret](${imageUrl}/image.png)`,
    'signed-preview': `![Screenshot](${imageUrl}/image.png?token=preview-secret)`,
    'signed-duplicates-saved': `![First](${imageUrl}/image.png?token=first-secret) ![Second](${imageUrl}/image.png?token=second-secret)`,
    'signed-live-saved': `![Screenshot](${imageUrl}/image.png?token=live-`,
    screenshot: `![Screenshot](${imageUrl}/screenshot.png)`,
  };
  const canonicalSources = {
    'angle-saved': ['/tmp/my image.png'],
    'title-saved': [`${imageUrl}/image.png`],
    'escaped-saved': ['/tmp/a(1).png'],
    'reference-saved': ['/tmp/my "image".png'],
    'geometry-saved': ['/tmp/private.png'],
    'streaming-angle-race': ['/tmp/my image.png'],
    'signed-saved': [`${imageUrl}/image.png?token=first-secret`],
    'signature-saved': [`${imageUrl}/image.png?signature=second-secret&expires=123`],
    'hash-saved': [`/tmp/${'a'.repeat(48)}.png`],
    'secret-reference-saved': [`${imageUrl}/image.png?token=reference-secret`],
    'signed-streaming-race': [`${imageUrl}/image.png?token=stream-secret`],
    'signed-duplicates-saved': [`${imageUrl}/image.png?token=first-secret`, `${imageUrl}/image.png?token=second-secret`],
    'signed-live-saved': [`${imageUrl}/image.png?token=live-secret`],
  };
  const bundle = await build({
    stdin: { contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {Theme, ChatMessageList, ChatMessage, ChatMessageBubble} from '@astryxdesign/core';
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
        if(captured.has(artifactId)) return captured.get(artifactId);
        if(mode.startsWith('layout-')) await fetch('/fixture/'+encodeURIComponent(artifactId));
        if(mode.startsWith('badge-')) await fetch('/badge-attachment');
        if(mode==='geometry-saved') await fetch('/release-attachment');
        reads++; window.imageReads=reads; return (mode==='attachment' || mode==='read-retry-saved') && reads===1 ? {ok:false,reason:'read_failed'} :
          {ok:true,base64:mode.startsWith('badge-') || artifactId.endsWith('badge.png') ? '${badge.toString('base64')}' : mode==='geometry-saved' || mode==='screenshot-saved' || artifactId.endsWith('screenshot.png') ? '${screenshot.toString('base64')}' : mode.endsWith('corrupt-saved') && reads===1 ? 'iVBORw0KGgo=' : '${png.toString('base64')}',mimeType:'image/png'};
      };
      const preview=mode==='preview' || mode==='signed-preview' || mode==='local';
      const seeded=mode.endsWith('saved') || mode.endsWith('saving') || race || mode.startsWith('badge-') || mode.startsWith('layout-');
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
        return mode.endsWith('saving') && window.deliveryQueries===1 ? {status:'pending'} : {status:'ready',artifactId:mode.startsWith('layout-') ? request.source : 'saved-image'};
      };
      const markdown=(streaming)=>React.createElement(ImageMessageProvider,{identity:{turnId:'turn',messageId},streaming},
        React.createElement(Markdown,{text,streaming,settledText:race ? text : undefined,density:'compact',imageDisplay:mode.startsWith('links-') ? 'link' : undefined}));
      const surface=(streaming)=>mode.startsWith('layout-') ? React.createElement('section',{className:mode==='layout-side' ? 'maka-quote-companion' : '',style:{width:mode==='layout-side' ? '360px' : '100%',maxWidth:'100%'}},
        React.createElement(ChatMessageList,{className:'maka-chat-message-list maka-chatContent',align:'top'},
          React.createElement('div',{className:'maka-transcript-turn maka-turn',style:{width:'100%',maxWidth:'var(--maka-reading-measure)',marginInline:'auto'}},
            React.createElement(ChatMessage,{sender:'assistant'},React.createElement(ChatMessageBubble,{variant:'ghost',width:'100%',className:'maka-chat-message-bubble maka-chat-message-bubble-assistant'},markdown(streaming)))))) : markdown(streaming);
      const render=(streaming=race || mode==='links-streaming')=>root.render(
        React.createElement(Theme,{theme:makaTheme,mode:'light'},
          React.createElement(LocaleProvider,{locale:'en'},
            React.createElement(SessionAttachmentProvider,{sessionId:'session',readBytes},
              React.createElement(ImageDeliveryProvider,{sessionId:'session',resolve:resolveDelivery},
              React.createElement('div',{style:mode==='offscreen' ? {paddingTop:'2500px'} : {}},
                surface(streaming)))))));
      window.nextMessage=()=>{messageId='next-message'; render(false);};
      window.finishStream=()=>render(false);
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
    if (req.url.startsWith('/fixture/')) { res.end(); return; }
    if (req.url === '/badge-attachment') { res.end(); return; }
    if (req.url === '/release-attachment') { void delayedAttachment.then(() => res.end()); return; }
    if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(js); }
    else if (req.url === '/app.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); }
    else {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><html><head><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="/app.css"></head><body><main id="root"></main><script src="/app.js"></script></body></html>`);
    }
  });
  await new Promise(resolve => appServer.listen(0, '127.0.0.1', resolve));
  appUrl = `http://127.0.0.1:${appServer.address().port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  releaseImage(); releaseAttachment();
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
    await page.getByText('Signed', {exact:true}).waitFor();
    assert.equal(await page.locator('a, img, .maka-markdown-image-resource').count(), 0);
    assert.doesNotMatch(await page.locator('#root').innerHTML(), /reasoning-secret|maka-image-display:/);
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

test('a remote image loads automatically and renders Host-owned bytes', async () => {
  requests = [];
  const page = await pageFor('remote');
  try {
    await loaded(page);
    assert.equal(await page.getByRole('button', { name: 'Load image', exact: true }).count(), 0);
    assert.deepEqual(requests, [{ path: '/image.png', referer: undefined }]);
    assert.match(await page.locator('img').getAttribute('src'), /^data:/);
  } finally { await page.close(); }
});

test('each message automatically resolves its own remote image identity', async () => {
  requests = [];
  const page = await pageFor('remote');
  try {
    await loaded(page);
    assert.equal(requests.length, 1);
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
        await page.getByText('The image address contains hidden sensitive information. Loading and opening it are disabled.', {exact:true}).waitFor();
        assert.equal(await page.getByText('Open in browser', {exact:true}).count(), 0);
      } else {
        await page.getByText('Remote images cannot be loaded here. You can open this image in your browser.', {exact:true}).waitFor();
        await page.getByText('Open in browser', {exact:true}).waitFor();
      }
      assert.deepEqual(requests, []);
      assert.equal(await page.locator('img').count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Load image', exact: true }).count(), 0);
      assert.ok(!(await page.locator('body').innerText()).includes('preview-secret'));
      // Prove the production CSP blocks a bypass of the Markdown component too.
      await page.evaluate(url => {
        const img=document.createElement('img'); img.src=url; document.body.append(img);
        return new Promise(resolve=> { img.onerror=resolve; img.onload=()=>resolve(); });
      }, `${imageUrl}/blocked.png`);
      assert.deepEqual(requests, []);
    } finally { await page.close(); }
  });
}

for (const scenario of ['signed-remote', 'signed-inline', 'signed-failed']) {
  test(`${scenario}: hidden destinations provide no network actions, including failure and inline states`, async () => {
    requests = [];
    const page = await pageFor(scenario);
    try {
      const message = 'The image address contains hidden sensitive information. Loading and opening it are disabled.';
      if (scenario === 'signed-inline') await page.getByRole('status', {name: message, exact: true}).waitFor();
      else await page.getByText(message, {exact: true}).waitFor();
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

test('redacting only image alt text does not disable a safe destination', async () => {
  requests = [];
  const page = await pageFor('secret-alt');
  try {
    assert.doesNotMatch(await page.locator('body').innerText(), /alt-secret/);
    await loaded(page);
    assert.equal(requests.length, 1);
  } finally { await page.close(); }
});

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

test('two signed destinations which redact alike replay their own saved attachments', async () => {
  requests = [];
  const page = await pageFor('signed-duplicates-saved');
  try {
    await page.waitForFunction(() => document.images.length === 2 && [...document.images].every(image => image.src.startsWith('data:') && image.naturalWidth === 1));
    assert.deepEqual(await page.evaluate(() => window.deliverySources), [
      `${imageUrl}/image.png?token=first-secret`, `${imageUrl}/image.png?token=second-secret`,
    ]);
    assert.deepEqual(requests, []);
    assert.doesNotMatch(await page.locator('body').innerText(), /first-secret|second-secret/);
  } finally { await page.close(); }
});

test('a signed image completed by a later text delta resolves its original destination', async () => {
  requests = [];
  const page = await pageFor('signed-live-saved');
  try {
    await page.waitForFunction(() => typeof window.appendText === 'function');
    assert.equal(await page.locator('img').count(), 0);
    await page.evaluate(() => window.appendText('secret)'));
    await loaded(page);
    assert.equal(await page.evaluate(() => window.deliverySource), `${imageUrl}/image.png?token=live-secret`);
    await page.evaluate(() => window.finishStream());
    await loaded(page);
    assert.deepEqual(requests, []);
    assert.doesNotMatch(await page.locator('body').innerText(), /live-secret/);
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

for (const scenario of ['corrupt-saved', 'signed-corrupt-saved']) {
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
      if(scenario==='signed-corrupt-saved') assert.equal(await page.getByText('Open in browser', {exact:true}).count(), 0);
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

for (const scenario of ['remote-saved', 'local-saved']) {
  test(`${scenario}: saved mapping avoids the original source and the image supports zoom`, async () => {
    requests = [];
    const page = await pageFor(scenario);
    try {
      await loaded(page);
      assert.deepEqual(requests, []);
      assert.equal(await page.evaluate(() => window.imageReads), 1);
      assert.equal(await page.locator('img').count(), 1);
      assert.match(await page.locator('img').getAttribute('src'), /^data:image\/png;base64,/);
      await page.getByRole('button', { name: 'Enlarge image: Screenshot', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.images.length > 1);
    } finally { await page.close(); }
  });
}
for (const scenario of ['local-saved', 'remote-saved', 'badge-saved', 'screenshot-saved']) {
  test(`${scenario}: clicking the image itself opens the enlarged preview`, async () => {
    requests = [];
    const page = await pageFor(scenario);
    try {
      const image = page.locator('.maka-markdown-image-preview img');
      await image.waitFor();
      await image.evaluate(image => image.decode());
      assert.equal(await page.locator('.maka-markdown-image-expand').count(), 0);
      assert.equal(await page.getByRole('button', { name: /^Enlarge image:/ }).count(), 1);
      const source = await image.getAttribute('src');
      const url = page.url();
      await image.hover();
      assert.equal(await image.evaluate(element => getComputedStyle(element).cursor), 'default');
      const evidence = scenario === 'screenshot-saved' && process.env.MAKA_IMAGE_LAYOUT_EVIDENCE_DIR;
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, 'click-image-ready.png'), fullPage: true });
      }
      await image.click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      assert.equal(await dialog.locator('img').getAttribute('src'), source);
      if (evidence) await page.screenshot({ path: join(evidence, 'click-image-enlarged.png'), fullPage: true });
      assert.equal(page.url(), url);
      assert.deepEqual(requests, []);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
    } finally { await page.close(); }
  });
}

for (const key of ['Enter', 'Space']) {
  test(`the image itself supports keyboard enlargement with ${key}`, async () => {
    const page = await pageFor('local-saved');
    try {
      await loaded(page);
      const trigger = page.locator('.maka-markdown-image-trigger');
      await trigger.focus();
      await page.keyboard.press(key);
      await page.getByRole('dialog').waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.activeElement?.classList.contains('maka-markdown-image-trigger'));
    } finally { await page.close(); }
  });
}

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
    await page.getByText('Saving image…', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('status').filter({ hasText: /\S/ }).count(), 0);
    assert.equal(await page.evaluate(() => window.deliveryQueries), 2);
    assert.equal(requests.length, 0);
  } finally { await page.close(); }
});

for (const scenario of ['streaming-race', 'settled-race', 'streaming-angle-race', 'signed-streaming-race']) {
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

for (const scenario of ['angle-saved', 'title-saved', 'escaped-saved', 'reference-saved', 'attachment-title', 'signed-saved', 'signature-saved', 'hash-saved', 'secret-reference-saved']) {
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

for (const scenario of ['geometry-remote', 'geometry-saved']) {
  test(`${scenario}: a compact placeholder expands to the decoded image's natural proportions`, async () => {
    const page = await pageFor(scenario);
    try {
      await page.getByText('Loading image…', { exact: true }).waitFor();
      const before = await page.getByText('Following paragraph', { exact: true }).boundingBox();
      if (scenario === 'geometry-remote') releaseImage(); else releaseAttachment();
      await page.waitForFunction(() => [...document.images].some(image => image.naturalWidth > 1));
      await page.getByText('Loading image…', { exact: true }).waitFor({ state: 'hidden' });
      const after = await page.getByText('Following paragraph', { exact: true }).boundingBox();
      assert.ok(after.y > before.y);
      const block = await page.locator('.maka-markdown-image-block').boundingBox();
      const image = await page.locator('.maka-markdown-image-preview img').boundingBox();
      assert.ok(Math.abs(block.width - image.width) < 1 && Math.abs(block.height - image.height) < 1);
    } finally {
      if (scenario === 'geometry-remote') releaseImage(); else releaseAttachment();
      await page.close();
    }
  });
}

test('natural image containers fit narrow viewports without distorting screenshots or limiting the enlarged preview', async () => {
  const page = await pageFor('screenshot');
  try {
    await page.waitForFunction(() => [...document.images].some(image => image.naturalWidth > 1));
    for (const width of [720, 360]) {
      await page.setViewportSize({ width, height: 600 });
      const geometry = await page.locator('.maka-markdown-image-preview img').evaluate(image => {
        const frame = image.closest('.maka-markdown-image-block').getBoundingClientRect();
        const box = image.getBoundingClientRect();
        return { frame: { x: frame.x, y: frame.y, right: frame.right, bottom: frame.bottom },
          box: { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height },
          ratio: image.naturalWidth / image.naturalHeight };
      });
      assert.ok(Math.abs(geometry.box.width / geometry.box.height - geometry.ratio) < 0.01);
      assert.ok(geometry.box.x >= geometry.frame.x && geometry.box.right <= geometry.frame.right + 1);
      assert.ok(geometry.box.y >= geometry.frame.y && geometry.box.bottom <= geometry.frame.bottom + 1, JSON.stringify(geometry));
      assert.ok(geometry.frame.right <= width);
    }
    await page.getByRole('button', { name: 'Enlarge image: Screenshot', exact: true }).click();
    await page.waitForFunction(() => document.images.length > 1);
    assert.equal(await page.locator('.maka-markdown-image-preview img').count(), 1);
    const dialog = await page.getByRole('dialog').boundingBox();
    const frame = await page.locator('.maka-markdown-image-block').boundingBox();
    assert.ok(dialog.height > frame.height);
    assert.equal(await page.getByRole('dialog').locator('img').getAttribute('src'), await page.locator('.maka-markdown-image-preview img').getAttribute('src'));
  } finally { await page.close(); }
});

for (const [name, naturalWidth, naturalHeight] of dimensions) {
  test(`${name}: body images shrink proportionally without upscaling or empty frames`, async () => {
    const page = await pageFor(`size-${name}`);
    try {
      await page.waitForFunction(() => [...document.images].some(image => image.complete && image.naturalWidth > 0));
      for (const [width, height] of [[1280, 900], [320, 600]]) {
        await page.setViewportSize({ width, height });
        const geometry = await page.locator('.maka-markdown-image-preview img').evaluate(image => {
          const block = image.closest('.maka-markdown-image-block');
          const column = block.parentElement;
          const style = getComputedStyle(column);
          const availableWidth = column.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
          const box = image.getBoundingClientRect();
          const container = block.getBoundingClientRect();
          return { width: box.width, height: box.height, right: box.right, availableWidth,
            containerWidth: container.width, containerHeight: container.height };
        });
        const scale = Math.min(1, 640 / naturalWidth, geometry.availableWidth / naturalWidth,
          Math.min(480, height * 0.6) / naturalHeight);
        assert.ok(Math.abs(geometry.width - naturalWidth * scale) < 1, JSON.stringify(geometry));
        assert.ok(Math.abs(geometry.height - naturalHeight * scale) < 1, JSON.stringify(geometry));
        assert.ok(Math.abs(geometry.containerWidth - geometry.width) < 1, JSON.stringify(geometry));
        assert.ok(Math.abs(geometry.containerHeight - geometry.height) < 1, JSON.stringify(geometry));
        assert.ok(geometry.right <= width);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      }
    } finally { await page.close(); }
  });
}

for (const scenario of ['badge-remote', 'badge-saved', 'badge-saving']) {
  test(`${scenario}: a badge keeps its intrinsic size and surrounding text on one line`, async () => {
    requests = [];
    const page = await pageFor(scenario);
    try {
      await page.waitForFunction(() => [...document.images].some(image => image.naturalWidth === 80));
      if (scenario === 'badge-saving') {
        await page.waitForFunction(() => [...document.images].some(image => image.src.startsWith('data:') && image.naturalWidth === 80));
      }
      const geometry = await page.locator('.maka-markdown-image-resource').evaluate(element => {
        const box = element.getBoundingClientRect();
        const paragraph = element.closest('[role="paragraph"]');
        const textBoxes = [...paragraph.childNodes].filter(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim()).map(node => {
          const range = document.createRange(); range.selectNodeContents(node);
          return range.getBoundingClientRect().y;
        });
        return { width: box.width, height: box.height, textBoxes };
      });
      assert.ok(geometry.width <= 120);
      assert.ok(geometry.height <= 32);
      const pixels = await page.locator('img').boundingBox();
      assert.equal(pixels.width, 80);
      assert.equal(pixels.height, 20);
      assert.equal(geometry.textBoxes.length, 2);
      assert.equal(geometry.textBoxes[0], geometry.textBoxes[1]);
      if (scenario === 'badge-saved') assert.deepEqual(requests, []);
      if (scenario === 'badge-remote') {
        await page.locator('.maka-markdown-image-preview').hover();
        await page.getByRole('button', { name: 'Enlarge image: Badge', exact: true }).click();
      } else {
        await page.getByRole('button', { name: 'Enlarge image: Badge', exact: true }).focus();
        await page.keyboard.press('Enter');
      }
      await page.getByRole('dialog').waitFor();
    } finally { await page.close(); }
  });
}

for (const scenario of ['badge-saved', 'badge-saving']) {
  test(`${scenario}: delayed saved bytes never change the inline placeholder geometry`, async () => {
    const page = await browser.newPage({ viewport: { width: 720, height: 600 } });
    page.setDefaultTimeout(5000);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/badge-attachment', async route => { await gate; await route.continue(); });
    try {
      await page.goto(`${appUrl}/?case=${scenario}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.imageReads === 0 && !!document.querySelector('.maka-markdown-image-inline'));
      const before = await page.locator('[role="paragraph"]').boundingBox();
      const slotBefore = await page.locator('.maka-markdown-image-resource').boundingBox();
      await page.waitForFunction(() => window.deliveryQueries >= (new URLSearchParams(location.search).get('case') === 'badge-saving' ? 2 : 1));
      release();
      await page.waitForFunction(() => [...document.images].some(image => image.src.startsWith('data:') && image.naturalWidth === 80));
      assert.deepEqual(await page.locator('.maka-markdown-image-resource').boundingBox(), slotBefore);
      assert.deepEqual(await page.locator('[role="paragraph"]').boundingBox(), before);
    } finally { release(); await page.close(); }
  });
}

for (const scenario of ['badge-list', 'badge-table', 'badge-strip']) {
  test(`${scenario}: inline Markdown context is known before the image arrives`, async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 600 } });
    page.setDefaultTimeout(5000);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/badge-attachment', async route => { await gate; await route.continue(); });
    try {
      await page.goto(`${appUrl}/?case=${scenario}`, { waitUntil: 'domcontentloaded' });
      await page.locator('.maka-markdown-image-inline').first().waitFor();
      assert.equal(await page.locator('.maka-markdown-image-block').count(), 0);
      const before = await page.locator('.maka-markdown-image-resource').first().boundingBox();
      assert.ok(before.width <= 120 && before.height <= 32);
      release();
      await page.waitForFunction(() => [...document.images].every(image => image.naturalWidth === 80));
      assert.deepEqual(await page.locator('.maka-markdown-image-resource').first().boundingBox(), before);
    } finally { release(); await page.close(); }
  });
}

for (const [scenario, width, height] of [
  ['layout-main', 1280, 900], ['layout-main', 480, 700],
  ['layout-side', 720, 700], ['layout-side', 320, 600],
]) {
  test(`${scenario} ${width}x${height}: production chat columns fit natural image dimensions`, async () => {
    const page = await browser.newPage({ viewport: { width, height } });
    page.setDefaultTimeout(5000);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/fixture/**', async route => { await gate; await route.continue(); });
    const measure = () => page.locator('.maka-markdown-image-resource').evaluateAll(elements => elements.map(element => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }));
    try {
      await page.goto(`${appUrl}/?case=${scenario}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelectorAll('.maka-markdown-image-resource').length === 2);
      await page.getByText('Following paragraph.').waitFor();
      const before = await measure();
      assert.equal(before.length, 2);
      assert.ok(before[0].width <= 120 && before[0].height <= 32);
      assert.ok(before[1].width <= 640 && before[1].height < 100);
      for (const box of before) assert.ok(box.x >= 0 && box.x + box.width <= width);
      const evidence = process.env.MAKA_IMAGE_LAYOUT_EVIDENCE_DIR;
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, `${scenario}-${width}-loading.png`), fullPage: true });
      }
      release();
      await page.waitForFunction(() => document.images.length === 2 && [...document.images].every(image => image.complete && image.naturalWidth > 0));
      const ready = await measure();
      assert.deepEqual(ready[0], before[0]);
      const image = await page.locator('.maka-markdown-image-block img').boundingBox();
      assert.ok(ready[1].width <= 640 && ready[1].height <= Math.min(480, height * 0.6));
      assert.ok(Math.abs(ready[1].width - image.width) < 1 && Math.abs(ready[1].height - image.height) < 1);
      assert.ok(Math.abs(image.width / image.height - 900 / 730) < 0.01);
      assert.ok((await page.getByText('Following paragraph.').boundingBox()).y >= image.y + image.height);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (evidence) {
        await page.screenshot({ path: join(evidence, `${scenario}-${width}-ready.png`), fullPage: true });
        console.log(JSON.stringify({ scenario, viewport: { width, height }, loading: before, ready }));
      }
    } finally { release(); await page.close(); }
  });
}
