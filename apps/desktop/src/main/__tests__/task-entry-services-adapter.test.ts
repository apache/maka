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
import { createDesktopTaskEntryServices } from '../../renderer/platform/desktop/create-task-entry-services.js';

describe('createDesktopTaskEntryServices', () => {
  it('maps only the Task Entry catalog and Project selection operations', async () => {
    const calls: Array<{ name: string; args: unknown[] }> = [];
    let changeHandler: (() => void) | undefined;
    let changes = 0;
    let disposed = 0;
    const catalog = { defaultProfileId: 'local', hosts: [] };
    const cancelled = { ok: false as const, reason: 'cancelled' as const };
    const bridge = {
      newTasks: {
        getCatalog: async () => {
          calls.push({ name: 'getCatalog', args: [] });
          return catalog;
        },
        subscribeChanges: (handler: () => void) => {
          calls.push({ name: 'subscribeChanges', args: [] });
          changeHandler = handler;
          return () => {
            disposed += 1;
          };
        },
        addProject: async (...args: unknown[]) => {
          calls.push({ name: 'addProject', args });
          return cancelled;
        },
        relinkProject: async (...args: unknown[]) => {
          calls.push({ name: 'relinkProject', args });
          return cancelled;
        },
      },
    } as unknown as Pick<MakaBridge, 'newTasks'>;
    const services = createDesktopTaskEntryServices(bridge);
    const host = { profileId: 'remote', hostId: 'host-1' };

    assert.equal(await services.catalog.getCatalog(), catalog);
    const unsubscribe = services.catalog.subscribeChanges(() => {
      changes += 1;
    });
    changeHandler?.();
    await services.catalog.addProject(host);
    await services.catalog.relinkProject(host, 'project-1');
    unsubscribe();

    assert.deepEqual(calls, [
      { name: 'getCatalog', args: [] },
      { name: 'subscribeChanges', args: [] },
      { name: 'addProject', args: [host] },
      { name: 'relinkProject', args: [host, 'project-1'] },
    ]);
    assert.equal(changes, 1);
    assert.equal(disposed, 1);
  });
});
