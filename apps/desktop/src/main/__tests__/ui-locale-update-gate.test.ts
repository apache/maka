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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createUiLocaleUpdateGate } from '../../renderer/settings/ui-locale-update-gate.js';

describe('UI locale settings update gate', () => {
  it('delivers a successful locale save after the Settings surface closes', async () => {
    const gate = createUiLocaleUpdateGate();
    const ticket = gate.begin(true);
    const savedLocales: string[] = [];
    const save = Promise.resolve('en' as const);

    // Closing Settings invalidates local UI ownership, but AppShell remains
    // mounted and still owns the locale callback.
    const surfaceMounted = false;
    await save.then((locale) => {
      assert.equal(surfaceMounted, false);
      assert.equal(gate.commit(ticket, locale, (next) => savedLocales.push(next)), true);
    });

    assert.deepEqual(savedLocales, ['en']);
  });

  it('ignores unrelated settings writes and rejects stale locale responses', () => {
    const gate = createUiLocaleUpdateGate();
    const firstLocaleTicket = gate.begin(true);
    assert.equal(gate.begin(false), null);
    const latestLocaleTicket = gate.begin(true);
    const savedLocales: string[] = [];

    assert.equal(gate.commit(firstLocaleTicket, 'en', (next) => savedLocales.push(next)), false);
    assert.equal(gate.commit(latestLocaleTicket, 'zh', (next) => savedLocales.push(next)), true);
    assert.deepEqual(savedLocales, ['zh']);
  });

  it('delivers the persisted auto preference without resolving it locally', () => {
    const gate = createUiLocaleUpdateGate();
    const savedPreferences: string[] = [];

    assert.equal(
      gate.commit(gate.begin(true), 'auto', (next) => savedPreferences.push(next)),
      true,
    );
    assert.deepEqual(savedPreferences, ['auto']);
  });

  it('rejects a stale hydration that started before a newer locale save', () => {
    const gate = createUiLocaleUpdateGate();
    const hydration = gate.beginHydration();
    const saveTicket = gate.begin(true);
    const applied: string[] = [];

    assert.equal(gate.commit(saveTicket, 'en', (next) => applied.push(next)), true);
    assert.equal(
      gate.commitHydration(hydration, 'zh', (next) => applied.push(next)),
      false,
    );
    assert.deepEqual(applied, ['en']);
  });

  it('rejects hydration started while a locale save is pending', () => {
    const gate = createUiLocaleUpdateGate();
    const saveTicket = gate.begin(true);
    const hydration = gate.beginHydration();
    const applied: string[] = [];

    assert.equal(
      gate.commitHydration(hydration, 'zh', (next) => applied.push(next)),
      false,
    );
    assert.equal(gate.commit(saveTicket, 'en', (next) => applied.push(next)), true);
    assert.deepEqual(applied, ['en']);
  });

  it('orders locale saves across Settings remounts with one AppShell gate', () => {
    const appShellGate = createUiLocaleUpdateGate();
    const firstSurfaceTicket = appShellGate.begin(true);
    const secondSurfaceTicket = appShellGate.begin(true);
    const applied: string[] = [];

    assert.equal(
      appShellGate.commit(secondSurfaceTicket, 'en', (next) => applied.push(next)),
      true,
    );
    assert.equal(
      appShellGate.commit(firstSurfaceTicket, 'zh', (next) => applied.push(next)),
      false,
    );
    assert.deepEqual(applied, ['en']);
  });

  it('releases a failed save so an in-flight hydration can apply', () => {
    const gate = createUiLocaleUpdateGate();
    const failedSaveTicket = gate.begin(true);
    const blockedHydration = gate.beginHydration();
    const applied: string[] = [];

    gate.cancel(failedSaveTicket);
    assert.equal(
      gate.commitHydration(blockedHydration, 'zh', (next) => applied.push(next)),
      true,
    );
    assert.deepEqual(applied, ['zh']);
  });

  it('applies the latest blocked hydration when an intervening locale save fails', () => {
    const gate = createUiLocaleUpdateGate();
    const hydration = gate.beginHydration();
    const failedSaveTicket = gate.begin(true);
    const applied: string[] = [];

    assert.equal(
      gate.commitHydration(hydration, 'zh', (next) => applied.push(next)),
      false,
    );
    assert.deepEqual(applied, []);

    gate.cancel(failedSaveTicket);
    assert.deepEqual(applied, ['zh']);
  });

  it('accepts an older pending save after the newer save fails', () => {
    const gate = createUiLocaleUpdateGate();
    const firstSaveTicket = gate.begin(true);
    const failedSaveTicket = gate.begin(true);
    const applied: string[] = [];

    gate.cancel(failedSaveTicket);
    assert.equal(
      gate.commit(firstSaveTicket, 'en', (next) => applied.push(next)),
      true,
    );
    assert.deepEqual(applied, ['en']);
  });

  it('restores an older successful save when the newer save fails later', () => {
    const gate = createUiLocaleUpdateGate();
    const firstSaveTicket = gate.begin(true);
    const failedSaveTicket = gate.begin(true);
    const applied: string[] = [];

    assert.equal(
      gate.commit(firstSaveTicket, 'en', (next) => applied.push(next)),
      false,
    );
    gate.cancel(failedSaveTicket);
    assert.deepEqual(applied, ['en']);
  });
});
