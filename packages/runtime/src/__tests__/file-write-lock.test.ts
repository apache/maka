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

/**
 * Tests for withFileWriteLock — per-key serialization that makes file-mutating
 * tools race-free when the AI SDK runs a step's tool calls concurrently.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { withFileWriteLock } from '../file-write-lock.js';

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('withFileWriteLock', () => {
  test('serializes tasks sharing a key, in submission order', async () => {
    const events: string[] = [];
    const task = (id: string) =>
      withFileWriteLock('serialize', async () => {
        events.push(`${id}:start`);
        await tick();
        await tick();
        events.push(`${id}:end`);
      });
    await Promise.all([task('a'), task('b'), task('c')]);
    // No interleaving: each task fully completes before the next starts.
    assert.deepEqual(events, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  test('different keys run concurrently', async () => {
    const events: string[] = [];
    const task = (key: string, id: string) =>
      withFileWriteLock(key, async () => {
        events.push(`${id}:start`);
        await tick();
        events.push(`${id}:end`);
      });
    await Promise.all([task('concurrent-x', 'a'), task('concurrent-y', 'b')]);
    // Both start before either ends — they did not serialize against each other.
    assert.equal(events[0], 'a:start');
    assert.equal(events[1], 'b:start');
    assert.deepEqual(events.slice(2).sort(), ['a:end', 'b:end']);
  });

  test('no lost update: serialized read-modify-write over a shared cell', async () => {
    const cell = { value: 0 };
    // Each task reads, yields, then writes read+1. Unserialized, concurrent tasks
    // would all read the same value and the final count would be < N.
    const bump = () =>
      withFileWriteLock('cell', async () => {
        const seen = cell.value;
        await tick();
        cell.value = seen + 1;
      });
    await Promise.all(Array.from({ length: 20 }, bump));
    assert.equal(cell.value, 20);
  });

  test('a rejecting task does not wedge the key', async () => {
    const order: string[] = [];
    const failing = withFileWriteLock('wedge', async () => {
      order.push('fail');
      throw new Error('boom');
    });
    await assert.rejects(failing, /boom/);
    const after = await withFileWriteLock('wedge', async () => {
      order.push('after');
      return 'ok';
    });
    assert.equal(after, 'ok');
    assert.deepEqual(order, ['fail', 'after']);
  });
});
