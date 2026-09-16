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

test('packaged process identities stay exact and either alias excludes owner or drag endpoints', () => {
  const aumid = `${'N'.repeat(50)}_8wekyb3d8bbwe!${'A'.repeat(63)}X`;
  const app = { name: 'Packaged editor', bundleIdentifier: 'win32.notepad', applicationUserModelId: aumid };
  const raw = { ...event, app };
  const projected = projectHistorySummaryEvent(JSON.stringify(raw), settings)!;
  assert.equal(projected.app?.bundleIdentifier, `winapp.${aumid}`);
  const different = projectHistorySummaryEvent(JSON.stringify({
    ...raw, app: { ...app, applicationUserModelId: aumid.slice(0, -1) + 'Y' },
  }), settings)!;
  assert.notEqual(projected.sourceKey, different.sourceKey);
  assert.notEqual(projected.app?.bundleIdentifier, different.app?.bundleIdentifier);
  for (const blocked of ['WIN32.NOTEPAD', `winapp.${aumid.toLowerCase()}`]) {
    const denied = { ...settings, blockedApplications: [blocked] };
    assert.equal(projectHistorySummaryEvent(JSON.stringify(raw), denied), null);
    for (const endpoint of ['origin', 'destination']) {
      assert.equal(projectHistorySummaryEvent(JSON.stringify({
        ...event, kind: 'mouse.drag', mouse: { [endpoint]: { app } },
      }), denied), null);
    }
    assert.notEqual(summaryScopeKey(settings), summaryScopeKey(denied));
  }
  for (const invalid of [null, '', 42, aumid + 'x', aumid.replace('!', '/'), aumid.replace('!', '!é')]) {
    assert.equal(projectHistorySummaryEvent(JSON.stringify({
      ...raw, app: { ...app, applicationUserModelId: invalid },
    }), settings), null);
  }
  assert.equal(projectHistorySummaryEvent(JSON.stringify({
    ...raw, app: { ...app, bundleIdentifier: 'org.example.editor' },
  }), settings), null);
  for (const bundleIdentifier of ['winapp.invalid', `winapp.${aumid}x`, 'win32.notepad.exe',
    'org.example.<script>', 'org.example.app/path', 'org.example.app --flag', 'org.example.app\u0000', null]) {
    assert.equal(projectHistorySummaryEvent(JSON.stringify({
      ...event, app: { name: 'Cannot bypass via display name', bundleIdentifier },
    }), settings), null);
  }
  const generic = `org.${'a'.repeat(233)}.App`;
  assert.equal(generic.length, 241);
  assert.equal(projectHistorySummaryEvent(JSON.stringify({
    ...event, app: { ...event.app, bundleIdentifier: generic },
  }), settings)!.app!.bundleIdentifier, generic);
});

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

test('selected rows retain their observed labels through the shared content gate', () => {
  const rowSelection = {
    ...event, kind: 'selection.changed', keyboard: undefined, ax: undefined,
    selection: { selectedItems: [
      { role: 'AXRow', title: 'Capture completeness', value: 'First input still missing' },
      { role: 'AXCell', description: 'Next check', value: 'Replay the cold-start scenario' },
    ] },
  };
  const line = JSON.stringify(rowSelection);
  const projected = projectHistorySummaryEvent(line, settings)!;
  assert.match(projected.content!, /Selected item 1:[\s\S]*Capture completeness[\s\S]*First input still missing/u);
  assert.match(projected.content!, /Selected item 2:[\s\S]*Next check[\s\S]*Replay the cold-start scenario/u);
  assert.doesNotMatch(projected.content!, /Selected text|Selection range|Keyboard target|accessibility content/u);
  assert.equal(projectHistorySummaryEvent(line, { ...settings, summaryTextEnabled: false })!.content, undefined);
  for (const patch of [{ sourceId: undefined }, { contentState: 'metadataOnly' }, { contentDomains: undefined }]) {
    assert.equal(projectHistorySummaryEvent(JSON.stringify({ ...rowSelection, ...patch }), settings)!.content, undefined);
  }
  assert.equal(projectHistorySummaryEvent(line, { ...settings, blockedDomains: ['work.example'] }), null);
  const legacy = projectHistorySummaryEvent(JSON.stringify({
    ...rowSelection, selection: { selectedText: 'Legacy selection' },
  }), settings)!;
  assert.match(legacy.content!, /Legacy selection/u);
});

test('selected item validation rejects unsafe or malformed items before all content projection', () => {
  const allowed = { role: 'AXRow', title: 'Allowed row' };
  for (const selectedItems of [
    null, {}, 'not-an-array', [null], [[]], [1], Array.from({ length: 33 }, () => allowed),
    [allowed, { role: 'AXSecureTextField', value: 'omit' }],
    [allowed, { role: 'AXRow', subrole: 'AXPasswordField' }],
    [allowed, { role: ['AXRow'] }], [allowed, { role: 'AXRow', subrole: 42 }],
  ]) {
    for (const summaryTextEnabled of [false, true]) {
      assert.equal(projectHistorySummaryEvent(JSON.stringify({
        ...event, selection: { selectedItems },
      }), { ...settings, summaryTextEnabled }), null);
    }
  }
});

test('selected item evidence redacts secrets and keeps Unicode clipping within the shared byte limit', () => {
  const secret = 'sk-syntheticSelectionSecret123456789';
  const selectedItems = Array.from({ length: 32 }, (_, index) => ({
    role: 'AXRow', title: `Row ${index + 1}`,
    value: index === 0 ? `token=${secret}` : '内容\n'.repeat(3_000),
  }));
  const projected = projectHistorySummaryEvent(JSON.stringify({
    ...event, keyboard: undefined, ax: undefined, selection: { selectedItems },
  }), settings)!;
  assert.doesNotMatch(projected.content!, /syntheticSelectionSecret|\ufffd/u);
  assert.match(projected.content!, /\[redacted\]/u);
  assert.match(projected.content!, /\[truncated\]$/u);
  assert.ok(Buffer.byteLength(projected.content!) <= 28 * 1024);
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

test('recorded actions retain shortcut and drag context without claiming successful outcomes', () => {
  const shortcut = {
    ...event, kind: 'keyboard.shortcut', ax: undefined, selection: undefined,
    keyboard: { keyEquivalent: 's', modifiers: ['command', 'shift', 'command', 'untrusted-modifier'] },
  };
  const projected = projectHistorySummaryEvent(JSON.stringify(shortcut), settings)!;
  assert.match(projected.content!, /Keyboard shortcut.*not proof of completion/u);
  assert.match(projected.content!, /command\+shift\+s/u);
  assert.doesNotMatch(projected.content!, /untrusted-modifier|command\+command/u);
  const functionShortcut = projectHistorySummaryEvent(JSON.stringify({
    ...shortcut, keyboard: { keyEquivalent: 'delete', modifiers: ['command', 'fn'] },
  }), settings)!;
  assert.match(functionShortcut.content!, /command\+fn\+delete/u);
  const submitted = projectHistorySummaryEvent(JSON.stringify({
    ...shortcut, kind: 'keyboard.submit', keyboard: { keyEquivalent: 'return', modifiers: [] },
  }), settings)!;
  assert.match(submitted.content!, /Submit key.*not proof of success.*return/u);

  const drag = {
    ...event, kind: 'mouse.drag', keyboard: undefined, selection: undefined, ax: undefined,
    mouse: {
      button: 'left', clickCount: 1, modifiers: ['option'],
      origin: {
        app: event.app, window: event.window,
        element: { role: 'AXRow', title: 'Draft section' },
      },
      destination: {
        app: { name: 'Notes', bundleIdentifier: 'org.example.notes' },
        window: { title: 'Final outline', url: 'https://notes.example/private-path?token=omit' },
        element: { role: 'AXTextArea', description: 'Review section' },
      },
    },
  };
  const moved = projectHistorySummaryEvent(JSON.stringify(drag), settings)!;
  assert.match(moved.content!, /Mouse input.*left.*count=1.*option/u);
  assert.match(moved.content!, /Drag origin[\s\S]*Draft section/u);
  assert.match(moved.content!, /Drag destination[\s\S]*Notes[\s\S]*Review section/u);
  assert.doesNotMatch(moved.content!, /private-path|token=omit|successfully moved/u);
  for (const button of [{ toString: null }, ['left'], null, 1]) {
    const malformed = projectHistorySummaryEvent(JSON.stringify({
      ...drag, mouse: { ...drag.mouse, button },
    }), settings)!;
    assert.match(malformed.content!, /Draft section/u);
    assert.doesNotMatch(malformed.content!, /Mouse input.*left/u);
  }
  for (const input of [shortcut, drag]) {
    assert.equal(projectHistorySummaryEvent(JSON.stringify(input), { ...settings, summaryTextEnabled: false })!.content, undefined);
    assert.equal(projectHistorySummaryEvent(JSON.stringify({ ...input, contentState: 'unavailable' }), settings)!.content, undefined);
  }
});

test('Mac input characters remain observations rather than committed application text', () => {
  // Synthetic composition-like input: event characters do not match the observed control value.
  const input = {
    ...event, kind: 'keyboard.text_input', ax: undefined, selection: undefined,
    keyboard: {
      text: 'nihao', keyEquivalent: null, modifiers: [],
      target: { role: 'AXTextArea', value: 'Existing draft' },
    },
  };
  for (const target of [input.keyboard.target, undefined]) {
    const line = JSON.stringify({
      ...input, keyboard: { ...input.keyboard, target },
    });
    const projected = projectHistorySummaryEvent(line, settings)!;
    assert.match(projected.content!, /\bnihao\b/u);
    assert.match(projected.content!, /observed input characters/iu);
    assert.match(projected.content!, /not proof of committed text.*submission/iu);
    assert.doesNotMatch(projected.content!, /Entered text|你好|successfully|value:.*nihao/iu);
    if (target) {
      assert.match(projected.content!, /Keyboard target:[\s\S]*value:\s*Existing draft/u);
    } else {
      assert.doesNotMatch(projected.content!, /Keyboard target|Existing draft/u);
    }
    assert.equal(projected.kind, 'keyboard.text_input');
    const metadata = projectHistorySummaryEvent(line, { ...settings, summaryTextEnabled: false })!;
    assert.equal(metadata.content, undefined);
    assert.doesNotMatch(JSON.stringify(metadata), /nihao|Existing draft/u);
  }
  const withoutCharacters = projectHistorySummaryEvent(JSON.stringify({
    ...input, keyboard: { ...input.keyboard, text: undefined },
  }), settings)!;
  assert.match(withoutCharacters.content!, /value:\s*Existing draft/u);
  assert.doesNotMatch(withoutCharacters.content!, /input characters|nihao|你好/iu);
});

test('selection coordinates retain the native UTF-16 contract across platforms', () => {
  const base = { ...event, kind: 'selection.changed', keyboard: undefined, ax: undefined };
  const mac = projectHistorySummaryEvent(JSON.stringify({
    ...base, selection: { selectedText: 'A😀B', selectedRange: { location: 10000, length: 4 } },
  }), settings)!;
  assert.match(mac.content!, /UTF-16.*start=10000, length=4/u);
  assert.match(mac.content!, /Selected text:\nA😀B/u);
  const win = projectHistorySummaryEvent(JSON.stringify({
    ...base, selection: { selectedText: 'A😀B', start: 10000, truncated: true },
  }), settings)!;
  assert.match(win.content!, /UTF-16.*start=10000/u);
  assert.match(win.content!, /Selected text \(partial\):\nA😀B/u);
  assert.doesNotMatch(win.content!, /length=/u);
  const partialMac = projectHistorySummaryEvent(JSON.stringify({
    ...base, selection: { selectedText: 'A😀B', selectedRange: { location: 10000, length: 9000 }, truncated: true },
  }), settings)!;
  assert.match(partialMac.content!, /UTF-16.*start=10000, length=9000/u);
  assert.match(partialMac.content!, /Selected text \(partial\):\nA😀B/u);
  assert.equal(projectHistorySummaryEvent(JSON.stringify({
    ...base, selection: { selectedText: 'A😀B', selectedRange: { location: 10000, length: 9000 }, truncated: true },
  }), { ...settings, summaryTextEnabled: false })!.content, undefined);
  for (const selection of [
    { start: -1 }, { start: 2.5 }, { start: Number.MAX_SAFE_INTEGER + 1 },
    { selectedRange: { location: 3, length: -1 } },
    { selectedRange: { location: 3, length: Number.MAX_SAFE_INTEGER } },
  ]) {
    assert.equal(projectHistorySummaryEvent(JSON.stringify({ ...base, selection }), settings)!.content, undefined);
  }
});

test('admitted input and selection preserve native-sized tails before the shared event budget', () => {
  const text = 'Observed paragraph.\n'.repeat(280) + 'FINAL_ACTION_DETAIL';
  assert.ok(Buffer.byteLength(text) > 4096 && Buffer.byteLength(text) < 8192);
  for (const details of [
    { kind: 'keyboard.text_input', keyboard: { text } },
    { kind: 'selection.changed', selection: { selectedText: text } },
    { kind: 'keyboard.submit', keyboard: { keyEquivalent: 'return', target: { role: 'AXTextArea', value: text } } },
    { kind: 'mouse.drag', mouse: { origin: { element: { role: 'AXTextArea', value: text } } } },
  ]) {
    const projected = projectHistorySummaryEvent(JSON.stringify({
      ...event, ax: undefined, selection: undefined, keyboard: undefined, ...details,
    }), settings)!;
    assert.match(projected.content!, /FINAL_ACTION_DETAIL$/u);
    assert.doesNotMatch(projected.content!, /\[truncated\]/u);
    assert.ok(Buffer.byteLength(projected.content!) <= 28 * 1024);
  }
});

test('malformed native security roles suppress evidence instead of interrupting summary enumeration', () => {
  for (const value of [{ toString: null }, ['AXSecureTextField'], 42]) {
    for (const key of ['role', 'subrole']) {
      for (const details of [
        { keyboard: { target: { [key]: value } } },
        { selection: { target: { [key]: value } } },
        { mouse: { target: { [key]: value } } },
        { mouse: { origin: { element: { [key]: value } } } },
        { mouse: { destination: { element: { [key]: value } } } },
      ]) {
        for (const summaryTextEnabled of [false, true]) {
          assert.equal(projectHistorySummaryEvent(JSON.stringify({
            ...event, ...details,
          }), { ...settings, summaryTextEnabled }), null);
        }
      }
    }
  }
});

test('drag endpoints recheck current exclusions and secure controls before any metadata is returned', () => {
  const base = { ...event, kind: 'mouse.drag' };
  for (const endpoint of [
    { app: { bundleIdentifier: 'com.apple.keychainaccess' } },
    { app: { secureInput: true } },
    { window: { url: 'https://sub.private.example/file' } },
    { window: { privateBrowsing: true } },
    { element: { role: 'AXSecureTextField' } },
  ]) {
    for (const side of ['origin', 'destination']) {
      for (const summaryTextEnabled of [false, true]) {
        assert.equal(projectHistorySummaryEvent(JSON.stringify({
          ...base, mouse: { [side]: endpoint },
        }), { ...settings, summaryTextEnabled }), null);
      }
    }
  }
  const clean = projectHistorySummaryEvent(JSON.stringify({
    ...base, mouse: { origin: {
      app: event.app, window: event.window,
      element: { role: 'AXRow', title: 'password=sk-syntheticSecretNeverTransmit123456' },
    } },
  }), settings)!;
  assert.match(clean.content!, /\[redacted\]/u);
  assert.doesNotMatch(JSON.stringify(clean), /syntheticSecret/u);
});
