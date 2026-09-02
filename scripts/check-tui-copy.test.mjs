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
import { checkSource, unexpectedFailures, unclassifiedTuiFiles } from './check-tui-copy.mjs';

function rules(source) {
  return checkSource(source).map(({ rule }) => rule);
}

test('rejects CJK in string and template literals', () => {
  assert.deepEqual(rules("const a = '重试'; const b = `失败：${reason}`;"), [
    'cjk-literal',
    'cjk-literal',
  ]);
});

test('ignores CJK in comments and runtime data', () => {
  assert.deepEqual(rules('// 中文说明\nconst copy = userInput;'), []);
});

test('rejects locale comparisons that select copy', () => {
  assert.deepEqual(rules("const copy = locale === 'zh' ? '重试' : 'Retry';"), [
    'locale-branch',
    'cjk-literal',
  ]);
  assert.deepEqual(rules("if (options.locale === 'en') notice('Retry');"), [
    'locale-branch',
    'visible-literal',
  ]);
  assert.deepEqual(rules("switch (input.locale) { case 'en': notice('Retry'); }"), [
    'locale-branch',
    'visible-literal',
  ]);
  assert.deepEqual(
    rules("switch (input.locale) { case 'en': count = 1; case 'zh': count = 2; }"),
    [],
  );
  assert.deepEqual(rules("const count = locale === 'zh' ? 1 : 2;"), []);
});

test('rejects literals at user-visible presentation sinks', () => {
  const failures = checkSource(`
    state.entries.push({ kind: 'notice', level: 'error', text: 'Try again' });
    const input = { title: 'Choose a model', hint: 'Enter select' };
    notice('Saved');
    new Text('Loading');
    notice(ansi.red('Wrapped failure'));
    const wrapped = { title: ansi.bold('Wrapped title') };
    const jsx = <p>Visible JSX</p>;
    const attribute = <Panel title="Visible title" data-value="machine-value" />;
  `);
  assert.deepEqual(
    failures.map(({ text }) => text),
    [
      'Try again',
      'Choose a model',
      'Enter select',
      'Saved',
      'Loading',
      'Wrapped failure',
      'Wrapped title',
      'Visible JSX',
      'Visible title',
    ],
  );
});

test('does not classify protocol fields or dynamic labels as copy literals', () => {
  assert.deepEqual(
    rules("const result = { kind: 'error', text: 'machine-value', label: value };"),
    [],
  );
});

test('the legacy inventory is exact in both directions', () => {
  const failure = {
    file: 'boundary.ts',
    line: 4,
    rule: 'visible-literal',
    text: 'Legacy copy',
  };
  const allowed = { 'boundary.ts': ['Legacy copy'] };
  assert.deepEqual(unexpectedFailures([failure], allowed), []);
  assert.deepEqual(unexpectedFailures([failure, failure], allowed), [failure]);
  assert.deepEqual(unexpectedFailures([], allowed), [
    {
      file: 'boundary.ts',
      line: 1,
      rule: 'stale-allowance',
      text: 'visible-literal: Legacy copy',
    },
  ]);
});

test('classifies every TUI source file as covered or infrastructure', () => {
  assert.deepEqual(unclassifiedTuiFiles(), []);
});
