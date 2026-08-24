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
 * createBrowserViewHost.canDrive — the visible-lease gate, with the
 * permission-modal viewport-restore wait. Driven through a fake manager +
 * controller (no Electron), so it exercises the host's orchestration: observe
 * is free, a backgrounded mutate is rejected without waiting, and a mutate on
 * the shown conversation waits for the renderer to restore the strip before
 * deciding. The controller's real poll lives in the Electron smoke.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createBrowserViewHost } from '../browser/automation-host.js';

type FakeController = {
  hasLiveViewport(): boolean;
  waitForLiveViewport(timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
};

function makeHost(shown: string | null, controller: FakeController | undefined) {
  const manager = { get: () => controller } as never;
  return createBrowserViewHost(manager, () => shown);
}

describe('createBrowserViewHost canDrive (visible lease + viewport-restore wait)', () => {
  it('observe on a backgrounded conversation is rejected (no off-screen reads)', async () => {
    const host = makeHost('other', { hasLiveViewport: () => false, waitForLiveViewport: async () => false });
    assert.equal(await host.canDrive('s', 'observe'), false);
  });

  it('observe on the shown conversation is allowed without a viewport', async () => {
    const host = makeHost('s', { hasLiveViewport: () => false, waitForLiveViewport: async () => false });
    assert.equal(await host.canDrive('s', 'observe'), true);
  });

  it('navigate on the shown conversation is allowed without a viewport, no wait', async () => {
    let waited = false;
    const host = makeHost('s', {
      hasLiveViewport: () => false,
      waitForLiveViewport: async () => {
        waited = true;
        return true;
      },
    });
    assert.equal(await host.canDrive('s', 'navigate'), true);
    assert.equal(waited, false);
  });

  it('mutate on a backgrounded conversation is rejected immediately, without waiting', async () => {
    let waited = false;
    const host = makeHost('other', {
      hasLiveViewport: () => false,
      waitForLiveViewport: async () => {
        waited = true;
        return false;
      },
    });
    assert.equal(await host.canDrive('s', 'mutate'), false);
    assert.equal(waited, false); // !shown → no viewport wait, fast reject
  });

  it('mutate on the shown conversation waits for the restored viewport, then allows', async () => {
    let live = false; // viewport absent (modal just closed) until the wait restores it
    const host = makeHost('s', {
      hasLiveViewport: () => live,
      waitForLiveViewport: async () => {
        live = true;
        return true;
      },
    });
    assert.equal(await host.canDrive('s', 'mutate'), true);
  });

  it('mutate on the shown conversation blocks when the viewport never returns', async () => {
    const host = makeHost('s', { hasLiveViewport: () => false, waitForLiveViewport: async () => false });
    assert.equal(await host.canDrive('s', 'mutate'), false);
  });
});
