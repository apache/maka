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
import type { ComputerHistorySettings } from '@maka/core/computer-history';
import { projectHistorySummaryEvent, summaryScopeKey } from '../computer-history-evidence.js';

const settings: ComputerHistorySettings = {
  enabled: true, captureText: true, summariesEnabled: true, summaryTextEnabled: true,
  blockedApplications: ['com.apple.keychainaccess'], blockedDomains: ['private.example'],
};
const event = {
  timestamp: '2026-09-13T13:10:00.000Z', kind: 'ui.changed',
  sourceId: '250ed63d-f651-440c-85c7-9b9fb72b553a',
  contentState: 'available', contentDomains: ['work.example'],
  app: { name: 'Editor', bundleIdentifier: 'org.example.editor' },
  window: { title: 'A project', url: 'https://work.example/page?token=never-send-url' },
  ax: { mode: 'fullTree', text: 'Heading: Task summary\nResult: checks passed' },
  keyboard: { text: 'Investigate endpoint regression', target: { role: 'AXTextArea', value: 'Draft request' } },
  selection: { selectedText: 'Selection canary' },
  privateField: 'unexpected-native-data',
};

test('text consent controls retained content independently of collection and local text capture', () => {
  for (const captureText of [true, false]) {
    const metadata = projectHistorySummaryEvent(JSON.stringify(event), { ...settings, captureText, summaryTextEnabled: false })!;
    assert.equal(metadata.content, undefined);
    assert.equal(metadata.window?.urlDomain, 'work.example');
    assert.doesNotMatch(JSON.stringify(metadata), /canary|regression|passed|Draft request|token=|unexpected-native/);
    const rich = projectHistorySummaryEvent(JSON.stringify(event), { ...settings, enabled: false, captureText })!;
    assert.match(rich.content!, /checks passed/);
    assert.match(rich.content!, /Selection canary/);
    assert.match(rich.content!, /Investigate endpoint regression/);
    assert.doesNotMatch(JSON.stringify(rich), /token=|unexpected-native/);
  }
});

test('untrusted legacy or unavailable content never becomes eligible through text consent', () => {
  for (const patch of [
    { contentState: undefined }, { contentState: 'unavailable' },
    { contentState: 'metadataOnly' }, { sourceId: undefined },
    { sourceId: 'not-a-window-identity' }, { contentDomains: undefined },
    { contentDomains: ['work.example', 3] },
    { contentDomains: ['https://work.example'] }, { contentDomains: ['work.example/path'] },
    { contentDomains: ['not a domain'] },
  ]) {
    assert.equal(projectHistorySummaryEvent(JSON.stringify({ ...event, ...patch }), settings)!.content, undefined);
  }
  const legacyDelta = projectHistorySummaryEvent(JSON.stringify({
    ...event, keyboard: undefined, selection: undefined, ax: { mode: 'diffFromPrevious', text: 'Missing baseline' },
  }), settings)!;
  assert.equal(legacyDelta.content, undefined);
});

test('current exclusions cover owner, contributing frame and secure fields before model projection', () => {
  for (const patch of [
    { app: { ...event.app, bundleIdentifier: 'com.apple.keychainaccess' } },
    { app: { ...event.app, secureInput: true } },
    { window: { ...event.window, url: 'https://sub.private.example/document' } },
    { window: { ...event.window, privateBrowsing: true } },
    { contentDomains: ['work.example', 'frame.private.example'] },
    { contentDomains: ['work.example', 'FRAME.PRIVATE.EXAMPLE.'] },
    { keyboard: { text: 'not-a-secret', target: { role: 'AXSecureTextField' } } },
  ]) {
    assert.equal(projectHistorySummaryEvent(JSON.stringify({ ...event, ...patch }), settings), null);
  }
  assert.notEqual(projectHistorySummaryEvent(JSON.stringify({
    ...event, contentDomains: ['notprivate.example'], window: { title: 'An app without a URL' },
  }), settings), null);
});

test('opaque window identity distinguishes same-title windows without leaking process identifiers', () => {
  const first = projectHistorySummaryEvent(JSON.stringify(event), settings)!;
  const second = projectHistorySummaryEvent(JSON.stringify({
    ...event, sourceId: '02ceee08-6e88-4ced-b204-2a18ad9436f8',
  }), settings)!;
  assert.notEqual(first.sourceKey, second.sourceKey);
  assert.equal(projectHistorySummaryEvent(JSON.stringify({
    ...event, window: { ...event.window, title: 'Renamed task' },
  }), settings)!.sourceKey, first.sourceKey);
  assert.match(first.sourceKey!, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(first), /250ed63d/);
});

test('rich projection preserves line structure within bounded UTF-8 and rejects malformed records', () => {
  const projected = projectHistorySummaryEvent(JSON.stringify({
    ...event, ax: { mode: 'fullTree', text: '内容\n'.repeat(30_000), truncated: true },
  }), settings)!;
  assert.ok(Buffer.byteLength(projected.content!) <= 28 * 1024);
  assert.match(projected.content!, /content \(partial\):\n内容\n/);
  assert.match(projected.content!, /\[truncated\]$/u);
  assert.ok(!projected.content!.includes('\ufffd'));
  for (const line of ['invalid', '{}', '{"timestamp":"not-time"}', '[]']) {
    assert.equal(projectHistorySummaryEvent(line, settings), null);
  }
});

test('model evidence redacts recognized credentials before content and title clipping', () => {
  const secret = 'sk-syntheticSecretNeverTransmit123456';
  const value = 'x '.repeat(14_330) + `api_key=${secret}`;
  const projected = projectHistorySummaryEvent(JSON.stringify({
    ...event,
    window: { title: `Task password=${secret}` },
    keyboard: { text: `Authorization: Bearer ${secret}` },
    selection: { selectedText: `token=${secret}` },
    ax: { mode: 'fullTree', text: value },
  }), settings)!;
  assert.doesNotMatch(JSON.stringify(projected), /syntheticSecret|sk-synthetic/u);
  assert.match(projected.content!, /\[redacted\]/u);
  assert.match(projected.window!.title!, /\[redacted\]/u);
  assert.ok(Buffer.byteLength(projected.content!) <= 28 * 1024);
});

test('derived context scopes use exclusions independent of ordering or collection toggles', () => {
  const scoped = { ...settings, blockedDomains: ['b.example', 'a.example'] };
  assert.equal(summaryScopeKey(scoped), summaryScopeKey({ ...scoped, enabled: false, blockedDomains: ['a.example', 'b.example'] }));
  assert.notEqual(summaryScopeKey(settings), summaryScopeKey({ ...settings, blockedDomains: [] }));
});
