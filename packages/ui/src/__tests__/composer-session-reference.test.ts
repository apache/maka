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
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import type { UiLocale } from '@maka/core/ui-locale';
import { Composer } from '../composer.js';
import { QuoteRefChip, quoteProvenanceSummary } from '../quote-ref-chip.js';
import { LocaleProvider } from '../locale-context.js';
import { getConversationCopy } from '../conversation-copy.js';

const quote = {
  text: 'User: reference text',
  label: 'Session: source',
  sourceSessionId: 'source-id',
  sourceSessionName: 'source',
  sourceCapturedAt: 0,
  sourceTruncated: true,
};

for (const [locale, label, captured, truncated] of [
  ['en', 'Session: source', 'captured', 'truncated'],
  ['zh-CN', '会话：source', '快照时间', '内容已截断'],
  ['zh-TW', '作業階段：source', '快照時間', '內容已截斷'],
] as const) {
  test(`Session quote renders its label and capture provenance in ${locale}`, () => {
    const markup = renderToStaticMarkup(createElement(LocaleProvider, {
      locale: locale as UiLocale,
      children: createElement(QuoteRefChip, { quote }),
    }));
    assert.ok(markup.includes(label));
    assert.ok(markup.includes(captured));
    assert.ok(markup.includes(truncated));
    assert.ok(markup.includes('1970-01-01T00:00:00.000Z'));
    assert.ok(markup.includes('lucide-messages-square'));
    if (locale !== 'en') {
      assert.equal(markup.includes('Session: source'), false);
      assert.equal(markup.includes(' · truncated'), false);
      assert.notEqual(getConversationCopy(locale).messages.sessionSnapshotPending, 'snapshot captured when sent');
    }
  });
}

test('quote provenance omits invalid dates and does not call complete content truncated', () => {
  for (const sourceCapturedAt of [-1, NaN, Infinity, 8.64e15 + 1]) {
    assert.equal(quoteProvenanceSummary({ ...quote, sourceCapturedAt }, 'en'), undefined);
  }
  assert.equal(quoteProvenanceSummary({ ...quote, sourceTruncated: false }, 'en'), 'captured 1970-01-01T00:00:00.000Z');
  assert.equal(quoteProvenanceSummary({ text: 'ordinary quote' }, 'en'), undefined);
});

for (const locale of ['en', 'zh-CN', 'zh-TW'] as const) {
  test(`pending Session remove control names the type and capture state in ${locale}`, () => {
    const messages = getConversationCopy(locale).messages;
    const markup = renderToStaticMarkup(createElement(LocaleProvider, {
      locale,
      children: createElement(Composer, {
        pendingSessionReferences: [{ id: 'source-id', name: 'Reference source' }],
        onRemovePendingSessionReference: () => undefined,
        onSend: () => undefined,
        onStop: () => undefined,
      }),
    }));
    const document = parseHTML(`<html><body>${markup}</body></html>`).document;
    const token = document.querySelector('.maka-composer-session-token');
    const removeName = token?.querySelector('button')?.getAttribute('aria-label');
    assert.ok(removeName);
    assert.ok(removeName.includes(messages.sessionSnapshotLabel('Reference source')));
    assert.ok(removeName.includes(messages.sessionSnapshotPending));
    assert.equal(token?.querySelector('.maka-composer-session-token-name')?.textContent, 'Reference source');
  });
}
