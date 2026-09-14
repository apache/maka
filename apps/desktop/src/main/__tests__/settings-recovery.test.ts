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

function harness(options: { e2e?: boolean; supported?: boolean; throws?: 'support' | 'create' | 'show' } = {}) {
  const notices: { title: string; body: string }[] = [];
  const logs: string[] = [];
  const failures: (() => void)[] = [];
  let supports = 0;
  const reporter = createSettingsRecoveryReporter({
    e2e: options.e2e ?? false,
    locale: () => 'en',
    log: (message) => { logs.push(message); },
    notifications: {
      isSupported() {
        supports += 1;
        if (options.throws === 'support') throw new Error('unsupported');
        return options.supported ?? true;
      },
      create(copy, failed) {
        if (options.throws === 'create') throw new Error('create failed');
        failures.push(failed);
        return { show() {
          if (options.throws === 'show') throw new Error('show failed');
          notices.push(copy);
        } };
      },
    },
  });
  return { reporter, notices, logs, failures, supports: () => supports };
}

test('localized recovery copy names the backup, privacy review and uncertain outcome', () => {
  for (const locale of UI_LOCALES) {
    const recovered = settingsRecoveryCopy(event, locale);
    const unknown = settingsRecoveryCopy({ ...event, outcome: 'commit-unknown' }, locale);
    assert.ok(recovered.body.includes(event.backupPath));
    assert.ok(unknown.body.includes(event.backupPath));
    assert.notEqual(recovered.title, unknown.title);
    assert.match(recovered.body, /Incognito|隐身|無痕/u);
    assert.doesNotMatch(recovered.body + unknown.body, /now off|已关闭|已關閉/u);
    assert.match(unknown.body, /unconfirmed|未确认|未確認/u);
    const failed = settingsRecoveryCopy({ ...event, outcome: 'commit-unknown' }, locale, true);
    assert.match(failed.body, /unconfirmed|未确认|未確認/u);
    assert.match(failed.body, /Restart|重启|重新啟動/u);
  }
});

test('early recovery is logged and reported immediately, then reread when effects become ready', async () => {
  const h = harness();
  let refreshes = 0;
  h.reporter.onRecovery(event);
  assert.equal(h.notices.length, 1);
  assert.ok(h.logs[0].includes(event.backupPath));
  assert.equal(refreshes, 0);
  const effects = { refresh: async (notify: boolean) => { assert.equal(notify, true); refreshes += 1; return true; } };
  h.reporter.setEffects(effects);
  await turn();
  assert.equal(refreshes, 1);
  h.reporter.setEffects(effects);
  await turn();
  assert.equal(refreshes, 1);
});

for (const options of [{ e2e: true }, { supported: false }]) {
  test('notification suppression does not suppress recovery diagnostics or effects', async () => {
    const h = harness(options);
    let refreshed = false;
    h.reporter.setEffects({ refresh: async () => { refreshed = true; return false; } });
    h.reporter.onRecovery(event);
    await turn();
    assert.equal(h.notices.length, 0);
    assert.equal(refreshed, true);
    assert.ok(h.logs.some((line) => line.includes(event.backupPath)));
    if (options.e2e) assert.equal(h.supports(), 0);
  });
}

for (const phase of ['support', 'create', 'show'] as const) {
  test(`notification ${phase} failure is isolated`, async () => {
    const h = harness({ throws: phase });
    h.reporter.onRecovery(event);
    await turn();
    assert.ok(h.logs.some((line) => line.includes('notification failed')));
  });
}

test('asynchronous native notification failure is logged without throwing', () => {
  const h = harness();
  h.reporter.onRecovery(event);
  assert.doesNotThrow(() => h.failures[0]());
  assert.ok(h.logs.some((line) => line.includes('notification failed')));
});

test('refresh failure keeps the publication warning and does not leak the failing effect error', async () => {
  const h = harness();
  h.reporter.setEffects({ refresh: async () => { throw new Error('secret effect detail'); } });
  h.reporter.onRecovery({ ...event, outcome: 'commit-unknown' });
  await turn();
  assert.equal(h.notices.length, 2);
  assert.match(h.notices[1].body, /unconfirmed/u);
  assert.match(h.notices[1].body, /Restart/u);
  assert.equal(JSON.stringify(h).includes('secret effect detail'), false);
  assert.ok(h.logs.some((line) => line.includes('refresh failed')));
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
    emitExternalChanged: () => { changes += 1; },
  });
  return { root, path: join(root, 'settings.json'), h, store, effects, observed, bots, keepAwake, changes: () => changes };
}

for (const notifyRenderer of [false, true]) {
  test(`recovery during effects.refresh(${notifyRenderer}) releases both queues and notifies the renderer once`, { timeout: 5_000 }, async (t) => {
    const { path, h, effects, observed, bots, keepAwake, changes, store } = await realStore(t);
    await store.update({ personalization: { uiLocale: 'zh-CN' }, system: { keepSystemAwake: true } });
    await effects.refresh(false);
    h.reporter.setEffects(effects);
    await writeFile(path, '{"secret":"never print this"');
    await effects.refresh(notifyRenderer);
    await turn();
    await effects.refresh(true); // Barrier behind the callback's queued refresh.
    assert.deepEqual(observed, ['zh-CN', 'auto', 'auto', 'auto']);
    assert.deepEqual(keepAwake, [true, false]);
    assert.equal(bots.length, 1); // Bots did not change, so effects deduplicate them.
    assert.equal(changes(), 1);
    assert.equal(h.notices.length, 1);
    assert.equal(h.logs.join('').includes('never print this'), false);
  });
}

test('recovery before effects initialization refreshes the latest file including a subsequent mutation', async (t) => {
  const { path, h, effects, store, observed } = await realStore(t);
  await writeFile(path, '');
  await store.update({ personalization: { uiLocale: 'zh-TW' } });
  h.reporter.setEffects(effects);
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
  h.reporter.setEffects(effects);
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
