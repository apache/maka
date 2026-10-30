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
import {
  completionToken,
  fileInvocation,
  referenceEdit,
} from '../../../../plugins/agent/composer/ui/composerCompletionSyntax.ts';

test('composer completion replaces the caret token while preserving Unicode prose and paths', () => {
  const source = '先😀 /rev旧尾 后文';
  const selection = { start: 8, end: 8 };
  const token = completionToken(source, selection);
  assert.deepEqual(token, { kind: 'slash', start: 4, end: 10, query: 'rev', leading: false });
  const edit = referenceEdit(source, selection, token, '/skill:review');
  assert.deepEqual(edit, { start: 4, end: 11, text: '/skill:review ' });
  assert.equal(
    source.slice(0, edit.start) + edit.text + source.slice(edit.end),
    '先😀 /skill:review 后文',
  );

  const quoted = '检查 @"docs/Rel old.md" 然后继续';
  const caret = quoted.indexOf(' old.md');
  const range = { start: caret, end: caret };
  const file = referenceEdit(
    quoted,
    range,
    completionToken(quoted, range),
    fileInvocation('docs/Release Notes.md'),
  );
  assert.equal(
    quoted.slice(0, file.start) + file.text + quoted.slice(file.end),
    '检查 @"docs/Release Notes.md" 然后继续',
  );

  assert.deepEqual(referenceEdit('前😀后', { start: 3, end: 3 }, null, '/skill:review'), {
    start: 3,
    end: 3,
    text: ' /skill:review ',
  });
  assert.deepEqual(completionToken('/mod', { start: 4, end: 4 }), {
    kind: 'slash',
    start: 0,
    end: 4,
    query: 'mod',
    leading: true,
  });
  assert.deepEqual(completionToken('/skill:', { start: 7, end: 7 }), {
    kind: 'skill',
    start: 0,
    end: 7,
    query: '',
    leading: true,
  });
  assert.deepEqual(completionToken('/skill:new', { start: 10, end: 10 }), {
    kind: 'skill',
    start: 0,
    end: 10,
    query: 'new',
    leading: true,
  });
  assert.deepEqual(completionToken('前 /skill:new 后', { start: 12, end: 12 }), {
    kind: 'skill',
    start: 2,
    end: 12,
    query: 'new',
    leading: false,
  });
  assert.deepEqual(completionToken('/new', { start: 4, end: 4 }), {
    kind: 'slash',
    start: 0,
    end: 4,
    query: 'new',
    leading: true,
  });
  assert.equal(completionToken('https://host/src', { start: 16, end: 16 }), null);
  assert.equal(completionToken('/usr/bin', { start: 8, end: 8 }), null);
});
