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

import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { createSessionVisitHistory } from '../../renderer/features/session-navigation/testing.js';

it('previews the next available visit without moving the cursor', () => {
  const history = createSessionVisitHistory();
  for (const id of ['A', 'B', 'C']) history.visit(id);
  assert.equal(history.peek(-1, (id) => id !== 'B'), 'A');
  assert.equal(history.peek(-1, () => true), 'B');
  assert.equal(history.peek(1, () => true), undefined);
  let opened: string | undefined;
  history.move(-1, () => true, (id) => { opened = id; return true; });
  assert.equal(opened, 'B');
});

it('traverses visits rather than sidebar order without recording traversal as a new visit', () => {
  const history = createSessionVisitHistory();
  const opened: string[] = [];
  const open = (id: string) => { opened.push(id); history.visit(id); return true; };
  for (const id of ['A', 'C', 'B']) history.visit(id);
  assert.equal(history.move(-1, () => true, open), true);
  assert.equal(history.move(-1, () => true, open), true);
  assert.equal(history.move(-1, () => true, open), false);
  assert.equal(history.move(1, () => true, open), true);
  assert.equal(history.move(1, () => true, open), true);
  assert.equal(history.move(1, () => true, open), false);
  assert.deepEqual(opened, ['C', 'A', 'C', 'B']);
});

it('deduplicates the current visit and discards forward history on a new branch', () => {
  const history = createSessionVisitHistory();
  const opened: string[] = [];
  const open = (id: string) => { opened.push(id); history.visit(id); return true; };
  for (const id of ['A', 'B', 'B', 'C']) history.visit(id);
  history.move(-1, () => true, open);
  history.visit('D');
  assert.equal(history.move(1, () => true, open), false);
  history.move(-1, () => true, open);
  history.move(-1, () => true, open);
  assert.deepEqual(opened, ['B', 'B', 'A']);
});

it('does not advance the cursor on a rejected or throwing open', () => {
  const history = createSessionVisitHistory();
  for (const id of ['A', 'B', 'C']) history.visit(id);
  assert.equal(history.move(-1, () => true, () => false), false);
  assert.throws(() => history.move(-1, () => true, () => { throw new Error('rejected'); }));
  let opened: string | undefined;
  history.move(-1, () => true, (id) => { opened = id; return true; });
  assert.equal(opened, 'B');
});

it('can go back to the immediately preceding visit when the current session is removed', () => {
  const history = createSessionVisitHistory();
  for (const id of ['A', 'B', 'C']) history.visit(id);
  history.forget(new Set(['C']));
  let opened: string | undefined;
  history.move(-1, () => true, (id) => { opened = id; return true; });
  assert.equal(opened, 'B');
});

it('retains only the latest 100 visits', () => {
  const history = createSessionVisitHistory();
  for (let i = 0; i < 120; i += 1) history.visit(String(i));
  const opened: string[] = [];
  while (history.move(-1, () => true, (id) => { opened.push(id); return true; })) {}
  assert.equal(opened.length, 99);
  assert.equal(opened.at(-1), '20');
});

it('skips unavailable targets without erasing visits and prunes confirmed removals', () => {
  const history = createSessionVisitHistory();
  const opened: string[] = [];
  const open = (id: string) => { opened.push(id); history.visit(id); return true; };
  for (const id of ['A', 'C', 'B', 'D']) history.visit(id);
  history.forget(new Set(['B']));
  assert.equal(history.move(-1, (id) => id !== 'C', open), true);
  assert.deepEqual(opened, ['A']);
  assert.equal(history.move(1, () => true, open), true);
  assert.deepEqual(opened, ['A', 'C']);
  assert.equal(history.move(1, () => true, open), true);
  assert.deepEqual(opened, ['A', 'C', 'D']);
});
