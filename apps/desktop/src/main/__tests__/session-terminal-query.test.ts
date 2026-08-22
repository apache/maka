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
import type { IDisposable, IParser } from '@xterm/xterm';
import {
  isColorQuery,
  isDeviceAttributesQuery,
  isDeviceStatusQuery,
  isWindowReportQuery,
  isXtVersionQuery,
  suppressTerminalQueryReplies,
} from '../../renderer/session-terminal-query.js';

test('recognizes pure and mixed OSC color queries', () => {
  assert.equal(isColorQuery(10, '?'), true);
  assert.equal(isColorQuery(11, '?'), true);
  assert.equal(isColorQuery(12, '?'), true);
  assert.equal(isColorQuery(10, '?;?;?'), true);
  assert.equal(isColorQuery(10, '?;#fff'), true);
  assert.equal(isColorQuery(4, '0;?'), true);
  assert.equal(isColorQuery(4, '0;?;15;?'), true);
  assert.equal(isColorQuery(4, '0;?;1;#fff'), true);
});

test('does not suppress OSC color setters or invalid query forms', () => {
  assert.equal(isColorQuery(10, 'rgb:0f0f/0f0f/1212'), false);
  assert.equal(isColorQuery(11, '#ffffff'), false);
  assert.equal(isColorQuery(4, '0;rgb:0000/0000/0000'), false);
  assert.equal(isColorQuery(4, '256;?'), false);
  assert.equal(isColorQuery(4, ''), false);
  assert.equal(isColorQuery(3, '?'), false);
});

test('recognizes device attribute and status reports by their first parameter', () => {
  assert.equal(isDeviceAttributesQuery([0]), true);
  assert.equal(isDeviceAttributesQuery([0, 0]), true);
  assert.equal(isDeviceAttributesQuery([0, 1]), true);
  assert.equal(isDeviceAttributesQuery([1, 0]), false);

  assert.equal(isDeviceStatusQuery([5]), true);
  assert.equal(isDeviceStatusQuery([5, 0]), true);
  assert.equal(isDeviceStatusQuery([6]), false);
  assert.equal(isDeviceStatusQuery([6, 1]), false);
  assert.equal(isDeviceStatusQuery([4, 0]), false);

  assert.equal(isXtVersionQuery([0]), true);
  assert.equal(isXtVersionQuery([0, 1]), true);
  assert.equal(isXtVersionQuery([1]), false);
});

test('recognizes window reports without intercepting window commands', () => {
  for (const operation of [11, 13, 14, 15, 16, 18, 19, 20, 21]) {
    assert.equal(isWindowReportQuery([operation]), true);
  }
  assert.equal(isWindowReportQuery([14, 0]), true);
  assert.equal(isWindowReportQuery([14, 2]), false);
  assert.equal(isWindowReportQuery([16, 0]), true);
  assert.equal(isWindowReportQuery([8, 24, 80]), false);
  assert.equal(isWindowReportQuery([22, 0]), false);
  assert.equal(isWindowReportQuery([23, 0]), false);
  assert.equal(isWindowReportQuery([[14]]), false);
});

test('mixed OSC color queries are suppressed and their setters are replayed', () => {
  const registered: Array<{ kind: string; id: unknown; callback: unknown }> = [];
  const writes: string[] = [];
  const disposable = (): IDisposable => ({ dispose() {} });
  const parser = {
    registerOscHandler: (id: number, callback: unknown) => {
      registered.push({ kind: 'osc', id, callback });
      return disposable();
    },
    registerCsiHandler: () => disposable(),
    registerDcsHandler: () => disposable(),
  } as unknown as IParser;
  const terminal = { parser, write: (data: string) => writes.push(data) };
  const queryReplies = suppressTerminalQueryReplies(terminal);
  const oscHandler = (id: number): ((data: string) => boolean) => {
    const callback = registered.find(
      (handler) => handler.kind === 'osc' && handler.id === id,
    )?.callback;
    assert.equal(typeof callback, 'function');
    return callback as (data: string) => boolean;
  };

  assert.equal(oscHandler(4)('0;?;1;#fff'), true);
  assert.deepEqual(writes, ['\x1b]4;1;#fff\x1b\\']);

  writes.length = 0;
  assert.equal(oscHandler(10)('?;#fff'), true);
  assert.deepEqual(writes, ['\x1b]11;#fff\x1b\\']);

  writes.length = 0;
  assert.equal(oscHandler(10)('#000;?;#fff'), true);
  assert.deepEqual(writes, ['\x1b]10;#000\x1b\\', '\x1b]12;#fff\x1b\\']);

  writes.length = 0;
  assert.equal(oscHandler(4)('0;#000;1;#fff'), false);
  assert.deepEqual(writes, []);
  queryReplies.dispose();
});

test('registers and disposes every xterm response-generating query handler', () => {
  const registered: Array<{ kind: string; id: unknown; callback: unknown }> = [];
  let disposed = 0;
  const disposable = (): IDisposable => ({
    dispose: () => {
      disposed += 1;
    },
  });
  const parser = {
    registerOscHandler: (id: number, callback: unknown) => {
      registered.push({ kind: 'osc', id, callback });
      return disposable();
    },
    registerCsiHandler: (id: unknown, callback: unknown) => {
      registered.push({ kind: 'csi', id, callback });
      return disposable();
    },
    registerDcsHandler: (id: unknown, callback: unknown) => {
      registered.push({ kind: 'dcs', id, callback });
      return disposable();
    },
  } as unknown as IParser;
  const terminal = { parser, write: (_data: string) => {} };

  const queryReplies = suppressTerminalQueryReplies(terminal);

  assert.equal(registered.length, 12);
  assert.deepEqual(
    registered.filter(({ kind }) => kind === 'osc').map(({ id }) => id),
    [4, 10, 11, 12],
  );
  assert.equal(
    registered.some(
      ({ kind, id }) =>
        kind === 'csi' && JSON.stringify(id) === JSON.stringify({ prefix: '>', final: 'q' }),
    ),
    true,
  );
  assert.equal(
    registered.some(
      ({ kind, id }) =>
        kind === 'dcs' && JSON.stringify(id) === JSON.stringify({ intermediates: '$', final: 'q' }),
    ),
    true,
  );
  queryReplies.dispose();
  assert.equal(disposed, registered.length);
});
