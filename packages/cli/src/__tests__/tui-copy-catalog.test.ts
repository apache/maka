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
import { describe, test } from 'node:test';
import { formatUiMessage, UI_LOCALES } from '@maka/core/ui-locale';
import { getTuiPickerCopy, onboardingFailureMessage } from '../pi-tui-pickers.js';
import { TUI_COPY_RESOURCES } from '../tui-copy-catalog.js';

const MESSAGE_VALUES = {
  count: 2,
  detail: 'HTTP 401',
  hasDetail: true,
  bytes: 40_000,
  serverId: 'filesystem',
  names: 'Alpha',
  failures: '/skill:nope (not found)',
  outcome: 'no model request was made.',
  request: 'nope',
  reason: 'not found',
  limit: 3,
  minimum: 1,
  maximum: 3,
  format: 'email',
  notice: 'The original account was deleted.',
  recovery: 'Add or enable a connection first.',
} as const;

describe('TUI copy resources', () => {
  test('registers every domain without a locale-specific getter branch', () => {
    for (const [domain, catalog] of Object.entries(TUI_COPY_RESOURCES)) {
      for (const locale of UI_LOCALES) assert.ok(catalog[locale], `${domain}/${locale}`);
    }
  });

  test('keeps translated coverage, variables, and ICU formatting aligned with English', () => {
    for (const [domain, catalog] of Object.entries(TUI_COPY_RESOURCES)) {
      const enLeaves = new Map(leafEntries(catalog.en));
      for (const locale of ['zh-CN', 'zh-TW'] as const) {
        const translatedLeaves = new Map(leafEntries(catalog[locale]));
        assert.deepEqual(
          [...translatedLeaves.keys()].sort(),
          [...enLeaves.keys()].sort(),
          `${domain}/${locale}`,
        );
        for (const [path, enTemplate] of enLeaves) {
          const translatedTemplate = translatedLeaves.get(path)!;
          const enVariables = messageVariables(enTemplate);
          const translatedVariables = messageVariables(translatedTemplate);
          assert.deepEqual(translatedVariables, enVariables, `${domain}/${locale}/${path}`);
          if (enVariables.length === 0) continue;
          assert.notEqual(
            formatUiMessage(enTemplate, MESSAGE_VALUES, 'en'),
            enTemplate,
            `${domain}/en/${path}`,
          );
          assert.notEqual(
            formatUiMessage(translatedTemplate, MESSAGE_VALUES, locale),
            translatedTemplate,
            `${domain}/${locale}/${path}`,
          );
        }
      }
    }
  });

  test('keeps model picker copy locale-specific', () => {
    assert.equal(getTuiPickerCopy('en').modelPickerTitle, 'Select Model');
    assert.equal(getTuiPickerCopy('en').searchLabel, 'Search');
    assert.equal(getTuiPickerCopy('zh-CN').modelPickerTitle, '选择模型');
    assert.equal(getTuiPickerCopy('zh-CN').searchLabel, '搜索');
    assert.equal(getTuiPickerCopy('zh-TW').modelPickerTitle, '選擇模型');
    assert.equal(getTuiPickerCopy('zh-TW').searchLabel, '搜尋');
    assert.equal(getTuiPickerCopy('zh-TW').selectPickerHint, '↑↓ 選擇 · Enter 確認 · Esc 關閉');
    assert.equal(getTuiPickerCopy('zh-CN').currentMarker, '当前');
    assert.equal(getTuiPickerCopy('zh-TW').defaultMarker, '預設');
  });

  test('formats the English MCP count with ICU plural rules', () => {
    const template = TUI_COPY_RESOURCES['mcp-status'].en.toolCount;

    assert.equal(formatUiMessage(template, { count: 1 }, 'en'), '1 tool');
    assert.equal(formatUiMessage(template, { count: 2 }, 'en'), '2 tools');
  });

  test('localizes rewind and skill notices in both locales', () => {
    assert.equal(TUI_COPY_RESOURCES.rewind.en.noTargets, 'No turns to rewind to.');
    assert.equal(TUI_COPY_RESOURCES.rewind['zh-CN'].noTargets, '没有可回退的轮次。');
    assert.equal(
      formatUiMessage(
        TUI_COPY_RESOURCES.skills.en.failedItem,
        { request: 'nope', reason: TUI_COPY_RESOURCES.skills.en.failureReasons.not_found },
        'en',
      ),
      '/skill:nope (not found)',
    );
    assert.equal(
      formatUiMessage(
        TUI_COPY_RESOURCES.skills['zh-CN'].failedItem,
        { request: 'nope', reason: TUI_COPY_RESOURCES.skills['zh-CN'].failureReasons.not_found },
        'zh-CN',
      ),
      '/skill:nope（未找到）',
    );
  });

  test('localizes stable onboarding failure codes at the TUI boundary', () => {
    assert.equal(
      onboardingFailureMessage({ kind: 'rejected', reason: 'connection_not_found' }, 'en'),
      'This connection no longer exists. Reopen /setup and try again.',
    );
    assert.equal(
      onboardingFailureMessage({ kind: 'rejected', reason: 'connection_not_found' }, 'zh-CN'),
      '该连接已不存在，请重新打开 /setup 后重试。',
    );
    assert.equal(
      onboardingFailureMessage({ kind: 'failed', errorClass: 'auth' }, 'zh-CN'),
      '服务商身份验证失败，请检查 API key 后重试。',
    );
    assert.equal(
      onboardingFailureMessage({ kind: 'unavailable' }, 'zh-CN'),
      '无法连接 Runtime Host，请重试。',
    );
    assert.equal(
      onboardingFailureMessage({ kind: 'failed', errorClass: 'auth' }, 'zh-TW'),
      '服務商身分驗證失敗，請檢查 API key 後重試。',
    );
  });
});

function leafEntries(value: unknown, prefix = ''): [string, string][] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => leafEntries(item, `${prefix}[${index}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) =>
      leafEntries(item, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [[prefix, String(value)]];
}

function messageVariables(template: string): string[] {
  return [
    ...new Set(
      [...template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)(?=[,}])/gu)].map((match) => match[1]!),
    ),
  ].sort();
}
