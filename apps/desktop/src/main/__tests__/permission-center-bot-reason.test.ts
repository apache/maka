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
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import { UI_LOCALES, type UiLocale } from '@maka/core/ui-locale';
import type { HealthSignal } from '@maka/core/health';
import { botStatusReasonMessage, getBotSettingsCopy } from '../../renderer/locales/settings-bot-copy.js';
import { getHealthCenterCopy, type HealthCenterCopy } from '../../renderer/locales/settings-health-copy.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
let localizedSignalDetail: (
  signal: HealthSignal,
  copy: HealthCenterCopy,
  locale: UiLocale,
) => string | undefined;

before(async () => {
  // The health page pre-resolves bot capability reasons at the page layer
  // (copy catalogs may not runtime-import each other); bundle it the same way
  // bot-chat-detail.test.ts does so node's ESM resolver sees a self-contained
  // module graph.
  const outdir = await mkdtemp(resolve(REPO_ROOT, 'apps/desktop/dist/main/__tests__/bot-reason-'));
  await build({
    entryPoints: [resolve(REPO_ROOT, 'apps/desktop/src/renderer/settings/health-center-page.tsx')],
    outdir,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    target: 'node20',
    logLevel: 'silent',
  });
  ({ localizedSignalDetail } = await import(pathToFileURL(resolve(outdir, 'health-center-page.mjs')).href));
  after(() => rm(outdir, { recursive: true, force: true }));
});

// Producers emit machine codes; every renderer surface must resolve them
// through the bot copy table. A raw code such as `gateway-closed-4004` must
// never survive to the page in any locale (P2: Permission Center regression).
const BOT_REASONS = ['gateway-closed-4004', 'stream-failed', 'connections-open-503', 'rate-limited'] as const;

test('bot capability reasons resolve to localized sentences for every locale', () => {
  for (const reason of BOT_REASONS) {
    for (const locale of UI_LOCALES) {
      const rendered = botStatusReasonMessage(reason, locale);
      assert.ok(rendered, `${locale}: ${reason} must render copy`);
      assert.notEqual(rendered, reason, `${locale}: ${reason} must not render raw`);
      assert.notEqual(rendered, getBotSettingsCopy(locale).status.detailsInLogs, `${locale}: ${reason} must localize, not fall back to detailsInLogs`);
    }
  }
});

test('unknown bot reasons degrade to the localized generic line, never the raw code', () => {
  for (const locale of UI_LOCALES) {
    assert.equal(botStatusReasonMessage('future-code', locale), getBotSettingsCopy(locale).status.detailsInLogs);
  }
});

test('health center renders localized bot capability reasons in all locales', () => {
  const signal = (reason: string): HealthSignal => ({
    id: 'capability:bot:discord',
    label: 'Discord Bot',
    scope: 'bot',
    layer: 'runtime_probe',
    status: 'warning',
    source: 'capability_snapshot',
    checkedAt: 1,
    message: 'capability_degraded',
    detail: { kind: 'capability_reason', reason },
    relatedCapabilityId: 'bot:discord',
  });
  for (const locale of UI_LOCALES) {
    const expected = getBotSettingsCopy(locale).statusReasons.withCode.gatewayClosed('4004');
    assert.equal(localizedSignalDetail(signal('gateway-closed-4004'), getHealthCenterCopy(locale), locale), expected);
    assert.ok(!localizedSignalDetail(signal('stream-failed'), getHealthCenterCopy(locale), locale)?.includes('stream-failed'));
  }
});

test('health center keeps the interim CJK passthrough for non-bot capability reasons', () => {
  const signal: HealthSignal = {
    id: 'capability:computer_use',
    label: 'Computer Use',
    scope: 'capability',
    layer: 'runtime_probe',
    status: 'warning',
    source: 'capability_snapshot',
    checkedAt: 1,
    message: 'capability_degraded',
    detail: { kind: 'capability_reason', reason: 'maka-cu service 启动失败、已退出或已停止。' },
    relatedCapabilityId: 'computer_use',
  };
  assert.equal(localizedSignalDetail(signal, getHealthCenterCopy('zh-CN'), 'zh-CN'), 'maka-cu service 启动失败、已退出或已停止。');
  assert.equal(localizedSignalDetail(signal, getHealthCenterCopy('en'), 'en'), 'See the corresponding settings page for details.');
});