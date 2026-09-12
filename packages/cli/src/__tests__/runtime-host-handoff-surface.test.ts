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
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import test from 'node:test';
import type { HostHandoffView } from '@maka/runtime-host/client';
import { createCliHostHandoffSurface } from '../runtime-host-handoff-surface.js';

test('handoff explains the blocker before prompting and clears stale consent on redraw', () => {
  const input = new PassThrough();
  let text = '';
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        text += chunk.toString();
        done();
      },
    }),
    { isTTY: true, columns: 120 },
  );
  const actions: string[] = [];
  const surface = createCliHostHandoffSurface(
    'zh-CN',
    input,
    output,
  )((revision, action) => {
    actions.push(`${revision}:${action}`);
  });
  const view: HostHandoffView = {
    revision: 'first',
    state: 'attention',
    reason: 'activity_unknown',
    target: { name: 'Local', location: 'local' },
    mayExitNaturally: false,
    actions: ['cancel', 'retry', 'interrupt'],
    defaultAction: 'cancel',
  };
  surface.update(view);
  const rendered = stripVTControlCharacters(text);
  assert.ok(rendered.trimStart().startsWith('需要确认是否停止后台服务'));
  assert.ok(rendered.indexOf('可能中断') < rendered.indexOf('Enter:'));
  assert.equal((rendered.match(/> /g) ?? []).length, 1);
  assert.doesNotMatch(rendered, /常驻服务|没有替换此服务的权限/);
  input.write('sto');
  text = '';
  surface.update({ ...view, revision: 'second' });
  assert.ok(stripVTControlCharacters(text).trimStart().startsWith('需要确认是否停止后台服务'));
  input.write('p\n');
  assert.deepEqual(actions, []);
  input.write('\n');
  assert.deepEqual(actions, ['second:cancel']);
  surface.close();
  input.end();
  output.end();
});

for (const [locale, title, action] of [
  ['en', 'Confirm before stopping the service', 'Stop and continue'],
  ['zh-CN', '需要确认是否停止后台服务', '停止并继续'],
  ['zh-TW', '需要確認是否停止背景服務', '停止並繼續'],
] as const) {
  test(`handoff honors ${locale} before the TUI starts`, () => {
    const input = new PassThrough();
    let text = '';
    const output = new Writable({
      write(chunk, _encoding, done) {
        text += chunk.toString();
        done();
      },
    });
    const surface = createCliHostHandoffSurface(locale, input, output)(() => {});
    surface.update({
      revision: 'locale',
      state: 'attention',
      reason: 'activity_unknown',
      target: { name: 'Local', location: 'local' },
      mayExitNaturally: false,
      actions: ['cancel', 'retry', 'interrupt'],
      defaultAction: 'cancel',
    });
    assert.ok(text.trimStart().startsWith(title));
    assert.ok(text.includes(action));
    if (locale === 'en') assert.doesNotMatch(text, /[\u3400-\u9fff]/u);
    surface.close();
    input.end();
    output.end();
  });
}

test('handoff keeps cancellation live during progress and disposes input without submitting', () => {
  const input = new PassThrough();
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const actions: string[] = [];
  const surface = createCliHostHandoffSurface(
    'en',
    input,
    output,
  )((revision, action) => {
    actions.push(`${revision}:${action}`);
  });
  const view: HostHandoffView = {
    revision: 'attention',
    state: 'attention',
    reason: 'activity_unknown',
    target: { name: 'Local', location: 'local' },
    mayExitNaturally: false,
    actions: ['cancel', 'retry', 'interrupt'],
    defaultAction: 'cancel',
  };
  surface.update(view);
  surface.update({
    ...view,
    revision: 'progress',
    state: 'progress',
    phase: 'retiring',
    actions: ['cancel'],
  });
  assert.deepEqual(actions, []);
  input.write('\n');
  assert.deepEqual(actions, ['progress:cancel']);
  surface.update({ ...view, revision: 'settling', state: 'progress', actions: [] });
  surface.close();
  input.end();
  output.end();
  assert.deepEqual(actions, ['progress:cancel']);
});
