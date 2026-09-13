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
import { describe, it } from 'node:test';
import type { MakaBridge } from '../../preload/bridge-contract.js';
import { createDesktopSessionNavigationServices } from '../../renderer/platform/desktop/create-session-navigation-services.js';

describe('createDesktopSessionNavigationServices', () => {
  it('maps the narrow catalog mutation contract to the Desktop bridge', async () => {
    const calls: Array<{ name: string; args: unknown[] }> = [];
    const sessions = new Proxy({}, {
      get: (_target, property) => (...args: unknown[]) => {
        calls.push({ name: String(property), args });
        if (property === 'list') return Promise.resolve([]);
        if (property === 'remove') return Promise.resolve('removed');
        return Promise.resolve(undefined);
      },
    });
    const services = createDesktopSessionNavigationServices({
      sessions,
    } as unknown as MakaBridge);

    await services.sessions.list();
    await services.sessions.setFlagged('s', true, { revisionFamily: true });
    await services.sessions.archive('s', { revisionFamily: true });
    await services.sessions.unarchive('s', { revisionFamily: true });
    await services.sessions.rename('s', 'Renamed', { revisionFamily: true });
    const disposition = await services.sessions.remove('s', {
      revisionFamily: true,
      requireArchived: false,
    });

    assert.equal(disposition, 'removed');
    assert.deepEqual(calls, [
      { name: 'list', args: [] },
      { name: 'setFlagged', args: ['s', true, { revisionFamily: true }] },
      { name: 'archive', args: ['s', { revisionFamily: true }] },
      { name: 'unarchive', args: ['s', { revisionFamily: true }] },
      { name: 'rename', args: ['s', 'Renamed', { revisionFamily: true }] },
      {
        name: 'remove',
        args: ['s', { revisionFamily: true, requireArchived: false }],
      },
    ]);
  });
});
