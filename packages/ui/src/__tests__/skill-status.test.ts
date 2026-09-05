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
import { UI_LOCALES } from '@maka/core/ui-locale';
import type { SkillEntry } from '../module-panel-types.js';
import { formatSkillLibraryDescription } from '../skill-status.js';
import { getSkillsCopy } from '../skills-copy.js';

const COMPUTER_USE_DESCRIPTION =
  'Use when the user asks to inspect or operate a local desktop application UI; prefer Browser tools for web pages.';

function skill(overrides: Partial<SkillEntry>): SkillEntry {
  return {
    id: 'computer-use',
    name: 'Computer Use',
    description: COMPUTER_USE_DESCRIPTION,
    path: '/skills/computer-use',
    enabled: true,
    runtimeStatus: 'enabled',
    ...overrides,
  };
}

test('bundled skills render the product description for their id in every locale', () => {
  for (const locale of UI_LOCALES) {
    const copy = getSkillsCopy(locale);
    const rendered = formatSkillLibraryDescription(skill({ sourceType: 'bundled' }), copy);
    assert.equal(rendered, copy.bundledDescription['computer-use'], locale);
    assert.notEqual(rendered, COMPUTER_USE_DESCRIPTION, locale);
    assert.notEqual(rendered, undefined, locale);
  }
});

test('a bundled skill the user edited keeps the edited description', () => {
  assert.equal(
    formatSkillLibraryDescription(
      skill({ sourceType: 'bundled', userModified: true, description: '操作本机应用。' }),
      getSkillsCopy('en'),
    ),
    '操作本机应用。',
  );
});

test('skills the user authored keep their own description in every locale', () => {
  for (const sourceType of ['workspace', 'managed', 'unknown', undefined] as const) {
    assert.equal(
      formatSkillLibraryDescription(skill({ id: 'docx', sourceType, description: 'Create and edit Word documents.' }), getSkillsCopy('zh-CN')),
      'Create and edit Word documents.',
    );
  }
  assert.equal(
    formatSkillLibraryDescription(
      skill({ id: 'notes', sourceType: 'workspace', description: '整理会议纪要。' }),
      getSkillsCopy('en'),
    ),
    '整理会议纪要。',
  );
});
