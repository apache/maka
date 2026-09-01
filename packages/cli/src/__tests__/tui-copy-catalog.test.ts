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
import { formatUiMessage } from '@maka/core/ui-locale';
import { getTuiPickerCopy, onboardingFailureMessage } from '../pi-tui-pickers.js';
import { TUI_COPY_RESOURCES } from '../tui-copy-catalog.js';

const MESSAGE_VALUES = {
  count: 2,
  detail: 'HTTP 401',
  hasDetail: true,
  serverId: 'filesystem',
  names: 'Alpha',
  failures: '/skill:nope (not found)',
  outcome: 'no model request was made.',
  request: 'nope',
  reason: 'not found',
  limit: 3,
  notice: 'The original account was deleted.',
  recovery: 'Add or enable a connection first.',
} as const;

describe('TUI copy resources', () => {
  test('registers every domain without a locale-specific getter branch', () => {
    for (const [domain, catalog] of Object.entries(TUI_COPY_RESOURCES)) {
      assert.ok(catalog.en, `${domain}/en`);
      assert.ok(catalog.zh, `${domain}/zh`);
    }
  });

  test('keeps Chinese coverage, variables, and ICU formatting aligned with English', () => {
    for (const [domain, catalog] of Object.entries(TUI_COPY_RESOURCES)) {
      const enLeaves = new Map(leafEntries(catalog.en));
      const zhLeaves = new Map(leafEntries(catalog.zh));

      assert.deepEqual([...zhLeaves.keys()].sort(), [...enLeaves.keys()].sort(), `${domain}/zh`);
      for (const [path, enTemplate] of enLeaves) {
        const zhTemplate = zhLeaves.get(path)!;
        const enVariables = messageVariables(enTemplate);
        const zhVariables = messageVariables(zhTemplate);
        assert.deepEqual(zhVariables, enVariables, `${domain}/zh/${path}`);
        if (enVariables.length === 0) continue;
        assert.notEqual(
          formatUiMessage(enTemplate, MESSAGE_VALUES, 'en'),
          enTemplate,
          `${domain}/en/${path}`,
        );
        assert.notEqual(
          formatUiMessage(zhTemplate, MESSAGE_VALUES, 'zh'),
          zhTemplate,
          `${domain}/zh/${path}`,
        );
      }
    }
  });

  test('keeps model picker copy locale-specific', () => {
    assert.equal(getTuiPickerCopy('en').modelPickerTitle, 'Select Model');
    assert.equal(getTuiPickerCopy('en').searchLabel, 'Search');
    assert.equal(getTuiPickerCopy('zh').modelPickerTitle, '选择模型');
    assert.equal(getTuiPickerCopy('zh').searchLabel, '搜索');
    assert.equal(getTuiPickerCopy('zh').selectPickerHint, '↑↓ 选择 · Enter 确认 · Esc 关闭');
    assert.equal(getTuiPickerCopy('zh').currentMarker, '当前');
    assert.equal(getTuiPickerCopy('zh').defaultMarker, '默认');
  });

  test('formats the English MCP count with ICU plural rules', () => {
    const template = TUI_COPY_RESOURCES['mcp-status'].en.toolCount;

    assert.equal(formatUiMessage(template, { count: 1 }, 'en'), '1 tool');
    assert.equal(formatUiMessage(template, { count: 2 }, 'en'), '2 tools');
  });

  test('localizes rewind and skill notices in both locales', () => {
    assert.equal(TUI_COPY_RESOURCES.rewind.en.noTargets, 'No turns to rewind to.');
    assert.equal(TUI_COPY_RESOURCES.rewind.zh.noTargets, '没有可回退的轮次。');
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
        TUI_COPY_RESOURCES.skills.zh.failedItem,
        { request: 'nope', reason: TUI_COPY_RESOURCES.skills.zh.failureReasons.not_found },
        'zh',
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
      onboardingFailureMessage({ kind: 'rejected', reason: 'connection_not_found' }, 'zh'),
      '该连接已不存在，请重新打开 /setup 后重试。',
    );
    assert.equal(
      onboardingFailureMessage({ kind: 'failed', errorClass: 'auth' }, 'zh'),
      '服务商身份验证失败，请检查 API key 后重试。',
    );
    assert.equal(
      onboardingFailureMessage({ kind: 'unavailable' }, 'zh'),
      '无法连接 Runtime Host，请重试。',
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
