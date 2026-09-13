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

// What `list_apps` costs, and what it should say.
//
// On a real three-call turn this was 12,933 bytes — about 3,600 tokens, 85% of
// the whole turn — spent confirming an app id the prompt had already named.
// Every model in a five-model sweep did it, from the strongest to the weakest,
// because it is the only bridge from a display name to the app id `observe`
// requires. That is a tool-surface cost, not a model habit.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildComputerUseTools } from '../computer-use-tools.js';
import type { CuAppSummary, CuDispatchBackend } from '../computer-use-types.js';

const APPS: CuAppSummary[] = [
  { appId: 'com.apple.TextEdit', pid: 1, name: '文本编辑', windowCount: 1 },
  // macOS reports the localized name, and it is often shorter than what a
  // person calls the application. This one is exactly that case.
  { appId: 'com.microsoft.VSCode', pid: 5, name: 'Code', windowCount: 1 },
  { appId: 'com.google.Chrome', pid: 6, name: 'Google Chrome', windowCount: 1 },
  { appId: 'com.apple.calculator', pid: 2, name: '计算器', windowCount: 1 },
  { appId: 'com.apple.dock', pid: 3, name: '程序坞', windowCount: 0 },
  { appId: 'com.apple.controlcenter', pid: 4, name: '控制中心', windowCount: 0 },
];

function backend(): CuDispatchBackend {
  return {
    async preflight() {
      return { accessibility: true, screenRecording: true };
    },
    async listApps() {
      return APPS;
    },
    async run() {
      return { outcome: { ok: true, tier: 'ax' } };
    },
  };
}

async function listApps(app?: string): Promise<{ text: string; modelText?: string }> {
  const tools = buildComputerUseTools({ backend: backend() });
  const [tool] = tools;
  const result = await tool!.impl({ action: 'list_apps', ...(app ? { app } : {}) }, {
    abortSignal: new AbortController().signal,
    sessionId: 's',
    turnId: 't',
    toolCallId: 'c',
  } as never);
  return result as { text: string; modelText?: string };
}

test('an unfiltered list leaves out apps the model could not drive anyway', async () => {
  const { modelText } = await listApps();
  const apps = JSON.parse(modelText ?? '{}').apps as Array<{ app_id: string }>;
  // An app with no window cannot be observed or driven, so listing it offers
  // nothing to do with. Measured on a real machine: 133 apps, 15 with windows.
  assert.deepEqual(
    apps.map((a) => a.app_id),
    ['com.apple.TextEdit', 'com.microsoft.VSCode', 'com.google.Chrome', 'com.apple.calculator'],
  );
});

test('a filter takes the name a person would use, in either language, and the id too', async () => {
  for (const query of ['文本编辑', 'textedit', 'TextEdit', 'com.apple.TextEdit']) {
    const { modelText } = await listApps(query);
    const apps = JSON.parse(modelText ?? '{}').apps as Array<{ app_id: string }>;
    assert.deepEqual(
      apps.map((a) => a.app_id),
      ['com.apple.TextEdit'],
      `"${query}" should resolve to one app`,
    );
  }
});

test('a filter can reach an app with no window, which the unfiltered list omits', async () => {
  // Asking for something by name is a statement that it is wanted; the
  // window-count shortcut is only a default for "show me what there is".
  const { modelText } = await listApps('程序坞');
  const apps = JSON.parse(modelText ?? '{}').apps as Array<{ app_id: string }>;
  assert.deepEqual(
    apps.map((a) => a.app_id),
    ['com.apple.dock'],
  );
});

test('nothing matched says what there is, so the next call is not the whole list', async () => {
  const { modelText } = await listApps('Sublime Text');
  const answer = JSON.parse(modelText ?? '{}') as {
    apps: unknown[];
    no_match_for: string;
    apps_with_windows: string[];
  };
  assert.deepEqual(answer.apps, []);
  assert.equal(answer.no_match_for, 'Sublime Text');
  // Without this the recovery is an unfiltered `list_apps`, which is the cost
  // the filter exists to avoid.
  assert.deepEqual(answer.apps_with_windows, [
    'com.apple.TextEdit',
    'com.microsoft.VSCode',
    'com.google.Chrome',
    'com.apple.calculator',
  ]);
});
