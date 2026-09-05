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
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createDefaultBotChannel } from '@maka/core/bot-chat-settings';
import { MAX_ALLOWED_USER_IDS } from '@maka/core/settings';
import { UI_LOCALES, type UiCatalog, type UiLocale } from '@maka/core/ui-locale';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as BotChatDetailModule from '../../renderer/settings/bot-chat-detail.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
let outdir: string;
let BotChatChannelDetail: typeof BotChatDetailModule.BotChatChannelDetail;

before(async () => {
  outdir = await mkdtemp(resolve(REPO_ROOT, 'apps/desktop/dist/main/__tests__/bot-chat-detail-'));
  const outfile = resolve(outdir, 'bot-chat-detail.mjs');
  await build({
    entryPoints: [resolve(REPO_ROOT, 'apps/desktop/src/renderer/settings/bot-chat-detail.tsx')],
    outfile,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    target: 'node20',
    logLevel: 'silent',
  });
  ({ BotChatChannelDetail } = await import(pathToFileURL(outfile).href));
});

after(async () => {
  if (outdir) await rm(outdir, { recursive: true, force: true });
});

const invalidUsers = ['@alice', '@bob', '@carol', '@dave', '@eve'];
const expectedCopy = {
  'zh-CN': {
    help: 'Telegram 用户 ID 是 64 位整数；填入后只接收列表里这些 ID 的来信，其它人发的消息会被静默忽略（不会回弹任何提示）。',
    cappedHelp: 'Telegram 用户 ID 是 64 位整数；填入后只接收列表里这些 ID 的来信，其它人发的消息会被静默忽略（不会回弹任何提示）。 （已达到上限）',
    warnings: [
      [1, '下列不是数字 ID，可能是用户名之类的输入，匹配不到任何人：@alice'],
      [3, '下列不是数字 ID，可能是用户名之类的输入，匹配不到任何人：@alice、@bob、@carol'],
      [4, '下列不是数字 ID，可能是用户名之类的输入，匹配不到任何人：@alice、@bob、@carol 等 4 项'],
      [5, '下列不是数字 ID，可能是用户名之类的输入，匹配不到任何人：@alice、@bob、@carol 等 5 项'],
    ],
  },
  'zh-TW': {
    help: 'Telegram 使用者 ID 是 64 位整數；填入後只接收列表裡這些 ID 的來信，其它人發的訊息會被靜默忽略（不會回彈任何提示）。',
    cappedHelp: 'Telegram 使用者 ID 是 64 位整數；填入後只接收列表裡這些 ID 的來信，其它人發的訊息會被靜默忽略（不會回彈任何提示）。 （已達到上限）',
    warnings: [
      [1, '下列不是數字 ID，可能是使用者名稱之類的輸入，符合不到任何人：@alice'],
      [3, '下列不是數字 ID，可能是使用者名稱之類的輸入，符合不到任何人：@alice、@bob、@carol'],
      [4, '下列不是數字 ID，可能是使用者名稱之類的輸入，符合不到任何人：@alice、@bob、@carol 等 4 項'],
      [5, '下列不是數字 ID，可能是使用者名稱之類的輸入，符合不到任何人：@alice、@bob、@carol 等 5 項'],
    ],
  },
  en: {
    help: 'Telegram user IDs are 64-bit integers. When set, only messages from these IDs are accepted; all others are silently ignored.',
    cappedHelp: 'Telegram user IDs are 64-bit integers. When set, only messages from these IDs are accepted; all others are silently ignored. (limit reached)',
    warnings: [
      [1, 'These entries are not numeric IDs and may be usernames, so they will not match anyone: @alice'],
      [3, 'These entries are not numeric IDs and may be usernames, so they will not match anyone: @alice, @bob, @carol'],
      [4, 'These entries are not numeric IDs and may be usernames, so they will not match anyone: @alice, @bob, @carol and 1 more'],
      [5, 'These entries are not numeric IDs and may be usernames, so they will not match anyone: @alice, @bob, @carol and 2 more'],
    ],
  },
} satisfies UiCatalog<{
  help: string;
  cappedHelp: string;
  warnings: [number, string][];
}>;

for (const locale of UI_LOCALES) {
  const expected = expectedCopy[locale];
  for (const [count, warning] of expected.warnings) {
    test(`${locale}: BotChatChannelDetail renders the full warning for ${count} invalid IDs`, () => {
      assert.deepEqual(renderAllowedUsersDescriptions(locale, invalidUsers.slice(0, count)), [
        expected.help,
        warning,
      ]);
    });
  }

  test(`${locale}: BotChatChannelDetail omits the warning for an empty allowlist`, () => {
    assert.deepEqual(renderAllowedUsersDescriptions(locale, []), [expected.help]);
  });

  for (const count of [MAX_ALLOWED_USER_IDS - 1, MAX_ALLOWED_USER_IDS]) {
    test(`${locale}: BotChatChannelDetail renders the full help for ${count} numeric IDs without a warning`, () => {
      const users = Array.from({ length: count }, (_, index) => String(123456789 + index));
      assert.deepEqual(renderAllowedUsersDescriptions(locale, users), [
        count === MAX_ALLOWED_USER_IDS ? expected.cappedHelp : expected.help,
      ]);
    });
  }
}

function renderAllowedUsersDescriptions(locale: UiLocale, allowedUserIds: readonly string[]) {
  const markup = renderToStaticMarkup(
    createElement(LocaleProvider, {
      locale,
      children: createElement(AstryxLocaleProvider, {
        children: createElement(ToastProvider, {
          children: createElement(BotChatChannelDetail, {
            provider: 'telegram',
            channel: { ...createDefaultBotChannel('telegram'), allowedUserIds },
            status: undefined,
            statusLoadError: null,
            actionBusy: false,
            pendingAction: null,
            restarting: false,
            onBack() {},
            async onUpdateChannel() { return true; },
            onTest() {},
            onTestAndConnect() {},
            onRestart() {},
            onDisconnectSession() {},
            async onReload() {},
            async onRefreshStatuses() { return true; },
          }),
        }),
      }),
    }),
  );
  const { document } = parseHTML(markup);
  const textarea = document.querySelector('textarea');
  assert.ok(textarea, 'the public detail must render the Telegram allowlist');
  assert.equal(textarea.textContent, allowedUserIds.join('\n'));
  const describedBy = textarea.getAttribute('aria-describedby');
  assert.ok(describedBy, 'the allowlist must reference its help and warning');
  return describedBy.split(/\s+/).map((id) => {
    const description = document.getElementById(id);
    assert.ok(description, `missing allowlist description ${id}`);
    return description.textContent;
  });
}
