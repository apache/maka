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

// Real Chromium checks the shipped theme/CSP, lazy chunks, clipboard and paint.
// No Electron profile, model provider, or network service is involved.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const examples = {
  java: 'public class Demo {\n  /* first\n     second 中文😀 */\n  String message = "Hello";\n  int count = 42;\n}',
  go: 'package main\nfunc main() {\n  message := "Hello"\n  count := 42\n}',
  rust: 'fn main() {\n  let message = "Hello";\n  let count = 42;\n}',
  c: 'int main(void) {\n  const char *message = "Hello";\n  return 42;\n}',
  cpp: 'int main() {\n  std::string message = "Hello";\n  return 42;\n}',
  csharp: 'public class Demo {\n  string message = "Hello";\n  int count = 42;\n}',
  sql: 'SELECT name, 42 FROM users\nWHERE name = \'Hello\';',
};
const fence = (language, code) => `\`\`\`${language}\n${code}\n\`\`\``;
let server, browser, appUrl;

before(async () => {
  const bundle = await build({
    stdin: { contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {Theme} from '@astryxdesign/core';
      import {makaTheme} from './apps/desktop/src/renderer/astryx-theme/maka.js';
      import {MarkdownBody} from './packages/ui/src/markdown-body.tsx';
      import {LocaleProvider} from './packages/ui/src/locale-context.tsx';
      import './apps/desktop/src/renderer/styles.css';
      const root = createRoot(document.getElementById('root'));
      window.renderMarkdown = ({text, mode='dark', density='compact', streaming=false}) => {
        document.documentElement.style.colorScheme = mode;
        root.render(<Theme theme={makaTheme} mode={mode}>
          <LocaleProvider locale="en"><main style={{padding:24, maxWidth:800, margin:'auto'}}>
            <MarkdownBody text={text} density={density} streaming={streaming} settledText={streaming ? text : undefined}/>
          </main></LocaleProvider>
        </Theme>);
      };
      window.longTasks = [];
      new PerformanceObserver(list => window.longTasks.push(...list.getEntries().map(e => e.duration)))
        .observe({type:'longtask'});
      window.renderMarkdown({text:${JSON.stringify(fence('typescript', 'const answer = "Hello";'))}});
    `, resolveDir: root, loader: 'jsx' },
    bundle: true, write: false, outdir: '/virtual', format: 'esm', splitting: true,
    entryNames: 'app', chunkNames: '[name]-[hash]', assetNames: 'assets/[name]-[hash]',
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const files = new Map(bundle.outputFiles.map(file => [file.path.replace('/virtual', ''), file.contents]));
  const index = await readFile(new URL('../../../apps/desktop/src/renderer/index.html', import.meta.url), 'utf8');
  const csp = index.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)[1];
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (files.has(path)) {
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'application/octet-stream');
      res.end(files.get(path));
    } else if (path === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`);
    } else res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  appUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function pageFor() {
  const page = await browser.newPage({ viewport: { width: 880, height: 900 } });
  page.setDefaultTimeout(5000);
  await page.goto(appUrl);
  await page.locator('.astryx-token-keyword').waitFor();
  return page;
}

async function render(page, props) {
  await page.evaluate(value => window.renderMarkdown(value), props);
}

for (const mode of ['dark', 'light']) {
  test(`${mode}: all seven grammars use visible Astryx syntax colours`, async () => {
    const page = await pageFor();
    try {
      await render(page, { mode, text: Object.entries(examples).map(([language, code]) => fence(language, code)).join('\n\n') });
      await page.waitForFunction(() => [...document.querySelectorAll('.astryx-code-block')]
        .length === 7 && [...document.querySelectorAll('.astryx-code-block')]
        .every(block => block.querySelector('.astryx-token-keyword')));
      for (const block of await page.locator('.astryx-code-block').all()) {
        const colours = await block.evaluate(el => ['code', '.astryx-token-keyword', '.astryx-token-string', '.astryx-token-number']
          .map(selector => getComputedStyle(el.querySelector(selector)).color));
        assert.equal(new Set(colours).size, 4, colours.join(', '));
      }
      assert.match(await page.locator('.astryx-token-comment').nth(1).innerText(), /second 中文😀/);
    } finally { await page.close(); }
  });
}

test('loads the optional grammar chunk only for extra languages and reuses it', async () => {
  const page = await pageFor();
  try {
    const grammarRequests = () => page.evaluate(() => performance.getEntriesByType('resource')
      .filter(e => e.name.includes('/markdown-code-tokenizer-')).length);
    assert.equal(await grammarRequests(), 0);
    for (const [alias, canonical] of [['c++', 'cpp'], ['c#', 'csharp'], ['JAVA', 'java'], ['golang', 'go'], ['rs', 'rust'], ['cs', 'csharp']]) {
      await render(page, { text: fence(alias, examples[canonical]), density: 'default' });
      await page.locator('.astryx-token-keyword').first().waitFor();
      await page.getByRole('group', { name: canonical, exact: true }).waitFor();
    }
    assert.equal(await grammarRequests(), 1);
  } finally { await page.close(); }
});

test('preserves literal source and clipboard; retains the existing disclosure control', async () => {
  const page = await pageFor();
  try {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: appUrl });
    const code = 'public class Demo {\n\n  String html = "<script>bad()</script>&amp;";\n  // 中文😀\n' + '  int n = 42;\n'.repeat(7) + '}';
    await render(page, { text: fence('java', code) });
    await page.locator('.astryx-token-number').first().waitFor();
    assert.equal(await page.locator('#root script').count(), 0);
    const toggle = page.getByRole('button', { name: 'java', exact: true });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await page.getByRole('button', { name: 'Copy code', exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), code);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.match(await page.locator('code').innerText(), /中文😀/);
  } finally { await page.close(); }
});

test('keeps code readable and copyable if the optional chunk fails', async () => {
  const page = await pageFor();
  try {
    let failures = 0;
    await page.route('**/markdown-code-tokenizer-*.js', route => { failures += 1; return route.abort(); });
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: appUrl });
    await render(page, { text: fence('java', examples.java) });
    await page.waitForFunction(() => document.querySelector('code')?.textContent.includes('public class Demo'));
    await page.waitForTimeout(150);
    assert.equal(failures, 1);
    assert.equal(await page.locator('[class*="astryx-token-"]').count(), 0);
    await page.getByRole('button', { name: 'Copy code', exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), examples.java);
  } finally { await page.close(); }
});

test('streaming and language changes cannot apply tokens to an obsolete source', async () => {
  const page = await pageFor();
  try {
    await page.route('**/markdown-code-tokenizer-*.js', async route => {
      await new Promise(resolve => setTimeout(resolve, 150));
      await route.continue();
    });
    const loading = page.waitForRequest('**/markdown-code-tokenizer-*.js');
    await render(page, { text: fence('java', 'public class Old {}') });
    await loading;
    const source = 'fn main() { let answer = "new 中文😀"; }';
    await render(page, { text: '```rust\n' + source, streaming: true });
    await page.waitForFunction(() => document.querySelector('.astryx-token-keyword')?.textContent === 'fn');
    assert.equal(await page.locator('.astryx-token-string').innerText(), '"new 中文😀"');
    assert.doesNotMatch(await page.locator('#root').innerText(), /Old/);
    await render(page, { text: fence('unknown', 'return 42;') });
    await page.waitForFunction(() => document.querySelector('code')?.textContent === 'return 42;');
    assert.equal(await page.locator('[class*="astryx-token-"]').count(), 0);
  } finally { await page.close(); }
});

test('bounded long blocks render completely; oversize input falls back without truncation', async t => {
  const page = await pageFor();
  try {
    for (const [language, sample] of Object.entries(examples)) {
      const code = (sample + '\n').repeat(Math.floor(19_000 / (sample.length + 1))).trimEnd();
      const start = performance.now();
      await render(page, { text: fence(language, code) });
      await page.waitForFunction(expected => document.querySelector('[role="group"]')?.getAttribute('aria-label') === expected
        && document.querySelectorAll('.astryx-token-number').length > 1, language);
      t.diagnostic(`${language}: ${code.length} UTF-16 units, visible after ${Math.round(performance.now() - start)}ms`);
    }
    const code = '// ' + 'x'.repeat(20_001) + '\nend-marker';
    await render(page, { text: fence('java', code) });
    await page.waitForFunction(() => document.querySelector('code')?.textContent.includes('end-marker'));
    assert.equal(await page.locator('[class*="astryx-token-"]').count(), 0);
    const tasks = await page.evaluate(() => window.longTasks);
    t.diagnostic(`Observed main-thread long tasks (ms): ${tasks.map(Math.round).join(', ') || 'none'}`);
    assert.ok(tasks.every(duration => duration < 1000), 'bounded examples must not stall Chromium for a second');
  } finally { await page.close(); }
});
