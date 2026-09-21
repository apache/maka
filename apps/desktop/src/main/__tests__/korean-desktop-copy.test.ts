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
import { test } from 'node:test';
import { buildCommandList } from '../../renderer/command-palette-commands.js';
import { getOnboardingCopy } from '../../renderer/locales/onboarding-copy.js';
import { getPermissionCenterCopy } from '../../renderer/locales/permission-center-copy.js';
import { getSettingsPreferencesCopy } from '../../renderer/locales/settings-preferences-copy.js';
import { getShellCopy } from '../../renderer/locales/shell-copy.js';
import { getShellRemainingCopy } from '../../renderer/locales/shell-remaining-copy.js';

type Accessor = (locale: 'en' | 'ko') => unknown;

const CATALOGS: ReadonlyArray<readonly [string, Accessor]> = [
  ['onboarding', getOnboardingCopy],
  ['permission center', getPermissionCenterCopy],
  ['settings preferences', getSettingsPreferencesCopy],
  ['shell', getShellCopy],
  ['shell remaining', getShellRemainingCopy],
];

// Every leaf path with its kind, so a missing key, an extra key, a string
// where the English has a template, or a shorter array all show up as a
// difference. Arrays are compared by length; their order is asserted where
// it matters.
function shape(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return [`${path}: array(${value.length})`];
  if (value !== null && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .flatMap((key) => shape((value as Record<string, unknown>)[key], path ? `${path}.${key}` : key));
  }
  return [`${path}: ${typeof value}`];
}

const HANGUL_SYLLABLE = /[가-힣]/;

for (const [name, get] of CATALOGS) {
  test(`Korean ${name} copy has the same shape as the English copy`, () => {
    const ko = get('ko');
    assert.ok(ko, `no ko catalog for ${name}`);
    assert.notEqual(ko, get('en'));
    assert.deepEqual(shape(ko), shape(get('en')));
  });
}

test('Korean command palette uses its own commands and settings sections, not the English ones', () => {
  // zh-CN and zh-TW share one pair of constants; pointing ko at EN_* would
  // typecheck and show English in the Korean palette.
  const ko = getShellCopy('ko').commandPalette;
  const en = getShellCopy('en').commandPalette;
  for (const [id, command] of Object.entries(ko.commands)) {
    assert.notEqual(command.label, en.commands[id as keyof typeof en.commands].label, id);
    assert.match(command.label, HANGUL_SYLLABLE, id);
  }
  for (const [section, label] of Object.entries(ko.settingsSections)) {
    assert.notEqual(label, en.settingsSections[section as keyof typeof en.settingsSections], section);
    assert.match(label, HANGUL_SYLLABLE, section);
  }
});

test('Korean palette commands carry Korean labels and Korean search keywords', () => {
  const commands = buildCommandList({
    locale: 'ko',
    activeSessionId: 'session-1',
    themePref: 'auto',
    connections: [],
    defaultSlug: null,
    onNewChat: () => {},
    onOpenSettings: () => {},
    onOpenSettingsSection: () => {},
    onOpenShortcuts: () => {},
    onSetTheme: () => {},
  });
  const byId = new Map(commands.map((command) => [command.id, command]));
  assert.equal(byId.get('action:new-chat')?.label, '새 작업');
  // Keywords cover words the label does not reach; the English and Chinese
  // keywords stay, because the map is shared across locales.
  assert.deepEqual(byId.get('action:new-chat')?.keywords, ['new', 'chat', 'start', '新', '建', '任务', '대화', '채팅']);
  assert.ok(byId.get('action:keyboard-help')?.keywords?.includes('도움말'));
  assert.ok(byId.get('theme:dark')?.keywords?.includes('어두운'));
});

test('Korean templates drop the English-only plural and case branches', () => {
  const shell = getShellCopy('ko').sessionRowActions;
  assert.equal(shell.deletedSubtaskNote(1), '하위 작업 1개를 보관된 작업으로 이동했습니다');
  assert.equal(shell.deletedSubtaskNote(3), '하위 작업 3개를 보관된 작업으로 이동했습니다');

  const proxy = getSettingsPreferencesCopy('ko').general;
  assert.equal(proxy.autoBypass(1).replace('1', '#'), proxy.autoBypass(3).replace('3', '#'));

  // The English lowercases the status label; Korean has no case to change.
  assert.equal(getPermissionCenterCopy('ko').summaryFilterAria('허용됨', 2, false), '허용됨 권한만 표시, 2개');
});

test('no Korean particle attaches directly to a user-supplied value', () => {
  // 을/를, 이/가, 은/는 and (으)로 change form with the final consonant of the
  // preceding word, which is unknowable for a placeholder, so the sentences
  // are built so that no syllable follows a value directly.
  const value = 'VALUE';
  const shell = getShellCopy('ko');
  const rendered = {
    openPath: shell.errors.openPath(value),
    saveSummary: shell.commandActions.saveSummary(12, value),
    deleteTitle: shell.sessionRowActions.deleteTitle(value),
    deleteRestoredTitle: shell.sessionRowActions.deleteRestoredTitle(value),
    deletedDescription: shell.skillActions.deletedDescription(value),
    planModeExitPendingDescription: shell.app.planModeExitPendingDescription(value),
    useSkillPrompt: shell.app.useSkillPrompt(value),
    summaryFilterAria: getPermissionCenterCopy('ko').summaryFilterAria(value, 2, true),
  };
  for (const [key, text] of Object.entries(rendered)) {
    const at = text.indexOf(value);
    assert.notEqual(at, -1, `${key} does not render its value`);
    const next = text.slice(at + value.length).replace(/^["”']/, '').charAt(0);
    assert.doesNotMatch(next, HANGUL_SYLLABLE, `${key}: "${text}"`);
  }
});

test('Korean OS permission names match what Korean macOS shows', () => {
  // The copy sends users to find these panes in System Settings.
  const permissions = getPermissionCenterCopy('ko').osPermissions;
  assert.equal(permissions.accessibility.label, '손쉬운 사용');
  assert.equal(permissions.screen_recording.label, '화면 및 시스템 오디오 녹음');
  assert.equal(permissions.automation.label, '자동화(Apple Events)');
});

test('Korean onboarding asks after a product failure and guides otherwise', () => {
  // `…해 주세요` asks the user to act again because the product could not;
  // a plain `…하세요` / `…세요` guides the next step.
  const hero = getOnboardingCopy('ko').hero;
  for (const state of ['needs_connection', 'needs_connection_credentials', 'needs_model'] as const) {
    assert.match(hero[state].title, /세요\.$/, state);
    assert.doesNotMatch(hero[state].title, /주세요\.$/, state);
  }
  for (const state of ['blocked:all_connections_unhealthy', 'blocked:all_connections_retired'] as const) {
    assert.match(hero[state].body, /주세요\.$/, state);
  }
});
