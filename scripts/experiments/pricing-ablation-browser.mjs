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

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, openSync, closeSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { smokeStory, startStaticServer } from '../storybook-visual-smoke.mjs';
const scriptDir = dirname(fileURLToPath(import.meta.url)),
  root = resolve(scriptDir, '../..');
const dir = resolve(
  root,
  process.env.MAKA_ABLATION_RESULTS ?? 'perf-results/pricing-ablation-20260930/reproduced',
);
const current = process.env.MAKA_ABLATION_CURRENT === '1';
const widths = (process.env.MAKA_ABLATION_WIDTHS ?? '1280').split(',').map(Number);
const variants = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['baseline', 'no-catalog-aria-binding', 'no-dialog-focus-repair', 'no-stable-focus-fallback'];
for (const variant of variants) {
  if (current && variant !== 'baseline')
    throw new Error('Current-source mode is only valid for baseline');
  if (!current && !existsSync(resolve(dir, 'runs', variant, 'result.json')))
    throw new Error('Run the Node experiment before its browser variant: ' + variant);
  const out = resolve(
      dir,
      'browser-static',
      process.env.MAKA_ABLATION_STORIES ?? 'catalog',
      variant,
    ),
    config = resolve(out, 'config');
  mkdirSync(config, { recursive: true });
  writeFileSync(resolve(out, 'loaded.jsonl'), '');
  writeFileSync(
    resolve(config, 'preview.ts'),
    `export {default} from ${JSON.stringify(resolve(root, 'apps/desktop/.storybook/preview.tsx'))};\n`,
  );
  writeFileSync(
    resolve(config, 'main.ts'),
    `import config from ${JSON.stringify(resolve(root, 'apps/desktop/.storybook/main.ts'))};
import {existsSync,readFileSync,appendFileSync} from 'node:fs';
import {relative,resolve} from 'node:path';
const root=${JSON.stringify(root)}, out=${JSON.stringify(out)}, mutation=${JSON.stringify(resolve(dir, 'runs', variant))};
export default {...config,stories:[${JSON.stringify(resolve(root, 'apps/desktop/stories/settings/pricing-editor.stories.tsx'))}],async viteFinal(base,options){
 const merged=await config.viteFinal(base,options);
 merged.plugins=[{name:'pricing-ablation',enforce:'pre',transform(code,id){
 const p=id.split('?')[0];const replacement=resolve(mutation,relative(root,p));
 if(${!current}&&p.startsWith(root+'/apps/desktop/src/renderer/features/usage/')&&existsSync(replacement)){
 appendFileSync(resolve(out,'loaded.jsonl'),JSON.stringify({path:relative(root,p)})+'\\n');return readFileSync(replacement,'utf8');
 }return null;}},...(merged.plugins??[])];return merged;
}};`,
  );
  let browser, server;
  try {
    const staticDir = resolve(out, 'static');
    const fd = openSync(resolve(out, 'build.log'), 'w');
    const build = spawn(
      resolve(root, 'node_modules/.bin/storybook'),
      ['build', '--config-dir', config, '--output-dir', staticDir],
      {
        cwd: resolve(root, 'apps/desktop'),
        stdio: ['ignore', fd, fd],
        env: { ...process.env, STORYBOOK_DISABLE_TELEMETRY: '1' },
      },
    );
    const status = await new Promise((r) => build.once('exit', r));
    closeSync(fd);
    if (status !== 0) throw new Error('Storybook build failed ' + status);
    if (!current && variant !== 'baseline') {
      const loaded = readFileSync(resolve(out, 'loaded.jsonl'), 'utf8');
      const expected =
        variant === 'no-stable-focus-fallback' ? 'pricing-controller.ts' : 'pricing-editor.tsx';
      if (!loaded.includes(expected)) throw new Error('Mutated browser source was not loaded');
    }
    server = await startStaticServer(staticDir);
    const url = server.baseUrl;
    browser = await chromium.launch({ headless: true });
    const results = [];
    const stories =
      process.env.MAKA_ABLATION_STORIES?.split(',') ??
      (variant === 'baseline'
        ? ['populated', 'manual-exact-key', 'validation', 'conflict', 'uncertain', 'host-review']
        : variant === 'no-catalog-aria-binding'
          ? ['manual-exact-key']
          : variant === 'no-stable-focus-fallback'
            ? ['populated']
            : ['conflict', 'uncertain', 'host-review']);
    for (const width of widths)
      for (const id of stories) {
        const page = await browser.newPage();
        let failures;
        try {
          await smokeStory(page, url, {
            storyId: 'product-settings-pricing--' + id,
            palette: 'default',
            colorScheme: 'light',
            locale: 'zh-CN',
            forcedColors: 'none',
            viewport: { width, height: 900 },
          });
          failures = [];
        } catch (e) {
          failures = [String(e)];
        }
        const focus = await page.evaluate(() => ({
          active: document.activeElement?.tagName,
          activeText: document.activeElement?.textContent?.slice(0, 100),
          dialog: document.querySelector('dialog')?.contains(document.activeElement),
          probe: window.__makaStorybookSmoke,
        }));
        await page.screenshot({ path: resolve(out, id + '-' + width + '.png') });
        results.push({ id, width, failures, focus });
        await page.close();
      }
    writeFileSync(resolve(out, 'results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ variant, current, browser: browser.version(), results }));
    if (variant === 'baseline' && results.some((result) => result.failures.length))
      process.exitCode = 1;
  } catch (error) {
    writeFileSync(resolve(out, 'error.txt'), String(error));
    console.log(JSON.stringify({ variant, invalid: String(error) }));
    process.exitCode = 1;
  } finally {
    await browser?.close();
    await server?.close();
  }
}
