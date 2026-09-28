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
import fs, { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { UI_LOCALES } from '@maka/core/ui-locale';
import { createDefaultSettings } from '@maka/core/settings';
import {
  createSettingsStore,
  SettingsRecoveryCommitUnknownError,
  type CorruptSettingsRecovery,
} from '@maka/storage/settings-store';
import { createClientSettingsEffects } from '../client-settings-effects.js';
import { createSettingsRecoveryReporter, settingsRecoveryCopy } from '../settings-recovery.js';

const event: CorruptSettingsRecovery = {
  settingsPath: '/profile/settings.json',
  backupPath: '/profile/settings.json.corrupt-1000-fixture',
  outcome: 'recovered',
};
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(options: {
  e2e?: boolean;
  supported?: boolean;
  throws?: 'support' | 'show';
  holdNotice?: boolean;
} = {}) {
  const notices: { title: string; body: string }[] = [];
  const appNotices: { title: string; message: string; detail: string }[] = [];
  const logs: string[] = [];
  const failures: (() => void)[] = [];
  const dismissals: (() => void)[] = [];
  let supports = 0;
  let available = false;
  let failNotice = false;
  const reporter = createSettingsRecoveryReporter({
    e2e: options.e2e ?? false,
    locale: () => 'en',
    log: (message) => { logs.push(message); },
    showNotice: async (copy) => {
      if (!available) return false;
      if (failNotice) throw new Error('secret dialog detail');
      appNotices.push(copy);
      if (options.holdNotice) await new Promise<void>((resolve) => { dismissals.push(resolve); });
      return true;
    },
    notifications: {
      isSupported() {
        supports += 1;
        if (options.throws === 'support') throw new Error('unsupported');
        return options.supported ?? true;
      },
      show(copy, failed) {
        failures.push(failed);
        if (options.throws === 'show') throw new Error('show failed');
        notices.push(copy);
      },
    },
  });
  return {
    reporter, notices, appNotices, logs, failures, dismissals,
    supports: () => supports,
    setAvailable: () => { available = true; reporter.onWindowReady(); },
    failNotice: (value: boolean) => { failNotice = value; },
  };
}

test('localized recovery guidance names full paths, reset scope, privacy review and uncertain outcome', () => {
  for (const locale of UI_LOCALES) {
    const recovered = settingsRecoveryCopy(event, locale);
    const unknown = settingsRecoveryCopy({ ...event, outcome: 'commit-unknown' }, locale);
    for (const copy of [recovered, unknown]) {
      assert.ok(copy.detail.includes(event.settingsPath));
      assert.ok(copy.detail.includes(event.backupPath));
      assert.ok(copy.body.indexOf(event.backupPath) < copy.body.indexOf('\n'));
      assert.match(copy.detail, /Incognito|隐身|無痕/u);
      assert.match(copy.detail, /bot configuration|机器人配置|機器人設定/u);
      assert.match(copy.detail, /onboarding|首次使用/u);
      assert.doesNotMatch(copy.detail, /now off|已关闭|已關閉/u);
    }
    assert.notEqual(recovered.title, unknown.title);
    assert.match(unknown.message + unknown.detail, /unconfirmed|未确认|未確認/u);
    assert.match(unknown.message + unknown.detail, /Restart|重启|重新啟動/u);
  }
});

for (const options of [{ supported: false }, { e2e: true }, { throws: 'show' as const }]) {
  test(`startup recovery survives unavailable native notifications (${JSON.stringify(options)})`, async () => {
    const h = harness(options);
    h.reporter.onRecovery(event);
    await turn();
    assert.equal(h.appNotices.length, 0);
    assert.ok(h.logs[0].includes(event.backupPath));
    h.setAvailable();
    await turn();
    assert.equal(h.appNotices.length, 1);
    assert.ok(h.appNotices[0].detail.includes(event.backupPath));
    h.reporter.onWindowReady();
    await turn();
    assert.equal(h.appNotices.length, 1);
    assert.equal(h.notices.length, 0);
    if ('e2e' in options) assert.equal(h.supports(), 0);
  });
}

for (const phase of ['support', 'show'] as const) {
  test(`notification ${phase} failure cannot suppress the app notice`, async () => {
    const h = harness({ throws: phase });
    h.setAvailable();
    h.reporter.onRecovery(event);
    await turn();
    assert.equal(h.appNotices.length, 1);
    assert.ok(h.logs.some((line) => line.includes('notification failed')));
  });
}

test('asynchronous native notification failure retains one app notice and never creates a second banner', async () => {
  const h = harness();
  h.setAvailable();
  h.reporter.onRecovery(event);
  assert.doesNotThrow(() => h.failures[0]());
  await turn();
  assert.equal(h.notices.length, 1);
  assert.equal(h.appNotices.length, 1);
  assert.ok(h.logs.some((line) => line.includes('notification failed')));
});

test('a failed app dialog remains pending for the next usable window without leaking the error', async () => {
  const h = harness();
  h.failNotice(true);
  h.setAvailable();
  h.reporter.onRecovery({ ...event, outcome: 'commit-unknown' });
  await turn();
  assert.equal(h.appNotices.length, 0);
  assert.ok(h.logs.some((line) => line.includes('app notice failed')));
  assert.equal(h.logs.join('').includes('secret dialog detail'), false);
  h.failNotice(false);
  h.reporter.onWindowReady();
  await turn();
  assert.equal(h.appNotices.length, 1);
  assert.match(h.appNotices[0].message + h.appNotices[0].detail, /unconfirmed/u);
  assert.equal(h.notices.length, 1);
});

test('multiple recoveries wait for dismissal and repeated window events do not repeat notices', async () => {
  const h = harness({ holdNotice: true });
  h.setAvailable();
  h.reporter.onRecovery(event);
  h.reporter.onRecovery({ ...event, backupPath: `${event.backupPath}-second`, outcome: 'commit-unknown' });
  await turn();
  assert.equal(h.appNotices.length, 1);
  h.reporter.onWindowReady();
  await turn();
  assert.equal(h.appNotices.length, 1);
  h.dismissals[0]();
  await turn();
  assert.equal(h.appNotices.length, 2);
  assert.match(h.appNotices[1].message + h.appNotices[1].detail, /unconfirmed/u);
  h.dismissals[1]();
  await turn();
  h.reporter.onWindowReady();
  await turn();
  assert.equal(h.appNotices.length, 2);
  // Reusing a complete backup on a later corruption is still a new reset.
  h.reporter.onRecovery(event);
  await turn();
  assert.equal(h.appNotices.length, 3);
  h.dismissals[2]();
});

async function realStore(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'maka-desktop-settings-recovery-'));
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  });
  const h = harness();
  const store = createSettingsStore(root, { onCorruptRecovery: h.reporter.onRecovery });
  const observed: string[] = [];
  const bots: unknown[] = [];
  const keepAwake: boolean[] = [];
  let changes = 0;
  const effects = createClientSettingsEffects({
    settingsStore: store,
    systemPrefersDark: () => false,
    applyWorkHub: async () => {},
    applyKeepSystemAwake: async (value) => { keepAwake.push(value); },
    applyBotSettings: async (value) => { bots.push(value); },
    applyAppIcon: async () => {},
    observeLocale: (settings) => { observed.push(settings.personalization.uiLocale); },
    emitExternalChanged: () => { changes += 1; return true; },
  });
  return { root, path: join(root, 'settings.json'), h, store, effects, observed, bots, keepAwake, changes: () => changes };
}

for (const notifyRenderer of [false, true]) {
  test(`recovery during effects.refresh(${notifyRenderer}) releases both queues and notifies the renderer once`, { timeout: 5_000 }, async (t) => {
    const { path, h, effects, observed, bots, keepAwake, changes, store } = await realStore(t);
    await store.update({ personalization: { uiLocale: 'zh-CN' }, system: { keepSystemAwake: true } });
    await effects.refresh(false);
    await writeFile(path, 'sk-live-SECRET');
    await effects.refresh(notifyRenderer);
    await turn();
    await effects.refresh(true); // The existing file watcher rereads after a silent theme refresh.
    assert.deepEqual(observed, ['zh-CN', 'auto', 'auto']);
    assert.deepEqual(keepAwake, [true, false]);
    assert.equal(bots.length, 1); // Bots did not change, so effects deduplicate them.
    assert.equal(changes(), 1);
    assert.equal(h.notices.length, 1);
    assert.equal(h.logs.join('').includes('sk-live-SECRET'), false);
  });
}

test('startup effects read the latest file including a mutation after recovery', async (t) => {
  const { path, h, effects, store, observed } = await realStore(t);
  await writeFile(path, '');
  await store.update({ personalization: { uiLocale: 'zh-TW' } });
  await turn();
  await effects.refresh(true);
  assert.ok(observed.every((locale) => locale === 'zh-TW'));
  assert.equal(h.notices.length, 1);
});

test('published reset failure is independently reported and consumers reread without replaying a mutation', {
  skip: process.platform === 'win32', timeout: 5_000,
}, async (t) => {
  const { root, path, h, effects, store, observed } = await realStore(t);
  await store.update({ personalization: { uiLocale: 'zh-CN' } });
  await effects.refresh(false);
  await writeFile(path, '{bad');
  const originalOpen = fs.open;
  let directoryCount = 0;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] === root && ++directoryCount === 2) {
      t.mock.method(handle, 'sync', async () => { throw new Error('injected reset fence failure'); });
    }
    return handle;
  });
  syncBuiltinESMExports();
  let patched = false;
  await assert.rejects(store.updateIf(() => { patched = true; return true; }, { personalization: { uiLocale: 'en' } }), SettingsRecoveryCommitUnknownError);
  await turn();
  await effects.refresh(true);
  assert.equal(patched, false);
  assert.equal(observed.at(-1), 'auto');
  assert.match(h.notices[0].body, /unconfirmed/u);
  assert.equal(h.notices.length, 1);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), createDefaultSettings());
});
