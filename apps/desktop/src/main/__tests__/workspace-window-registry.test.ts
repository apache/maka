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
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createWorkspaceWindowRegistry } from '../workspace-window-registry.js';

test('commands target only the active workspace, and main close preserves session window identity', () => {
  const registry = createWorkspaceWindowRegistry();
  const delivered: string[] = [];
  const make = (id: string, kind: 'main' | 'session') => {
    const window = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      isFocused: () => false,
      webContents: { isDestroyed: () => false, send: () => delivered.push(id) },
    });
    registry.register({ context: { kind, windowId: id } as never, window: window as never, controller: {} as never });
    return window;
  };
  const main = make('1', 'main');
  const child = make('2', 'session');
  child.emit('focus');
  registry.sendCommand('window:command', { id: 'search' });
  assert.deepEqual(delivered, ['2']);
  assert.equal(registry.forSender(child.webContents as never)?.context.windowId, '2');
  assert.equal(registry.forSender({ isDestroyed: () => false } as never), undefined);
  main.emit('closed');
  assert.equal(registry.main(), undefined);
  assert.equal(registry.entries().length, 1);
  assert.throws(() => { make('3', 'main'); make('4', 'main'); }, /already exists/);
});
