#!/usr/bin/env node
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
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { connectRenderer, DEFAULT_PORT } from './cdp-client.mjs';

// Run against a disposable CDP-enabled Electron fixture. Real Chromium DOM,
// shipped CJS/ESM bundles, public xterm API; only intersection delivery is
// controlled so the regression does not depend on native window occlusion.
const require = createRequire(import.meta.url);
const packageRoot = dirname(dirname(require.resolve('@xterm/xterm')));
const c = await connectRenderer(Number(process.argv[2] ?? DEFAULT_PORT));
await c.ready;
const timeout = setTimeout(() => {
  c.close();
  process.exitCode = 1;
  console.error('xterm visibility regression timed out');
}, 20_000);

try {
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await c.send('Page.setBypassCSP', { enabled: true });
  for (const format of ['js', 'mjs']) {
    const source = readFileSync(join(packageRoot, 'lib', `xterm.${format}`), 'utf8');
    const css = readFileSync(join(packageRoot, 'css', 'xterm.css'), 'utf8');
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    const load =
      format === 'js'
        ? `(w.eval(${JSON.stringify(source)}), w.Terminal)`
        : `(await w.eval('import(' + JSON.stringify(${JSON.stringify(moduleUrl)}) + ')')).Terminal`;
    const result = await c.evaluate(`(async () => {
      const frame = document.createElement('iframe');
      frame.dataset.xtermVisibilityProbe = '';
      frame.style.cssText = 'position:fixed;left:0;top:0;width:650px;height:350px;z-index:99999';
      document.body.append(frame);
      let terminal, observer;
      try {
        const w = frame.contentWindow, d = w.document;
        d.head.innerHTML = '<style>' + ${JSON.stringify(css)} + '</style>';
        d.body.innerHTML = '<div id="host" style="width:600px;height:300px"></div>';
        w.eval('window.__io=[];window.IntersectionObserver=class{constructor(callback){window.__io.push(callback)}observe(){}disconnect(){}}');
        const Terminal = ${load};
        terminal = new Terminal({ cols: 80, rows: 12, cursorBlink: false });
        terminal.open(d.getElementById('host'));
        const settle = () => new Promise(resolve => setTimeout(resolve, 100));
        const visible = value => {
          d.getElementById('host').hidden = !value;
          w.__io.forEach(callback => callback([{ isIntersecting: value, intersectionRatio: value ? 1 : 0 }]));
        };
        visible(true);
        await new Promise(resolve => terminal.write('abcdefghijklmnop', resolve));
        await settle();
        terminal.select(0, 0, 3);
        await settle();
        visible(false);
        await settle();
        let changes = 0;
        observer = new w.MutationObserver(records => changes += records.length);
        observer.observe(d.querySelector('.xterm-rows'), { childList: true, subtree: true });
        terminal.select(3, 0, 3);
        terminal.clearSelection();
        terminal.select(6, 0, 3);
        await settle();
        const hiddenChanges = changes, selection = terminal.getSelection();
        visible(true);
        await settle();
        const box = d.querySelector('.xterm-selection div');
        return { hiddenChanges, resumedChanges: changes - hiddenChanges,
          selection, left: box ? parseFloat(box.style.left) : null };
      } finally {
        observer?.disconnect();
        terminal?.dispose();
        frame.remove();
      }
    })()`);
    console.log(format, result);
    assert.equal(result.hiddenChanges, 0, `${format}: hidden selection must not render`);
    assert.equal(result.selection, 'ghi', `${format}: retain the latest logical selection`);
    assert.ok(result.resumedChanges > 0, `${format}: resume must paint without new output`);
    assert.ok(result.left > 0, `${format}: resume must paint the latest selection`);
  }
} finally {
  clearTimeout(timeout);
  try {
    await c.send('Page.setBypassCSP', { enabled: false });
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  } finally {
    c.close();
  }
}
