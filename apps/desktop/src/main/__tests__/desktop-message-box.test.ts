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
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';
import type { MessageBoxOptions } from 'electron';
import type { WindowRevealMode } from '../window-reveal.js';

const source = (await transform(
  readFileSync(new URL('../../../src/main/desktop-message-box.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs', target: 'esnext' },
)).code;

function load(revealMode: WindowRevealMode) {
  const calls: string[] = [];
  const electron = {
    app: {
      focus: (options: { steal: boolean }) => calls.push(`focus steal=${options.steal}`),
    },
    dialog: {
      showMessageBox: async (...args: unknown[]) => {
        calls.push(args.length === 2 ? 'sheet' : 'app-modal');
        return { response: 0, checkboxChecked: false };
      },
    },
  };
  const module = { exports: {} as typeof import('../desktop-message-box.js') };
  runInNewContext(source, {
    module,
    exports: module.exports,
    require: (name: string) => (name === 'electron' ? electron : { revealMode }),
  });
  return { calls, ...module.exports };
}

const options: MessageBoxOptions = { message: 'Quit?', buttons: ['Quit', 'Keep running'], cancelId: 1 };

test('a run that cannot reveal a dialog settles it as cancelled without showing it', async () => {
  const box = load('hidden');
  assert.equal((await box.presentMessageBox(options)).response, 1);
  box.bringDecisionForward();
  assert.deepEqual(box.calls, []);
});

test('a dialog activates the app before it is shown, attached to the parent when there is one', async () => {
  const box = load('active');
  await box.presentMessageBox(options, {} as Electron.BrowserWindow);
  await box.presentMessageBox(options);
  assert.deepEqual(box.calls, ['focus steal=true', 'sheet', 'focus steal=true', 'app-modal']);
});

test('an E2E run that shows windows does not steal activation', async () => {
  const box = load('inactive');
  await box.presentMessageBox(options);
  assert.deepEqual(box.calls, ['app-modal']);
});
