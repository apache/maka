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
import { describe, it } from 'node:test';
import { createSafeRendererSender } from '../safe-renderer-send.js';

describe('safe renderer send', () => {
  it('forwards the channel and arguments to a live BrowserWindow', () => {
    const deliveries: Array<[channel: string, ...args: unknown[]]> = [];
    const window = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (channel: string, ...args: unknown[]) => {
          deliveries.push([channel, ...args]);
        },
      },
    };
    const send = createSafeRendererSender(() => window);

    send('sessions:changed', { hostId: 'local' }, 7);

    assert.deepEqual(deliveries, [
      ['sessions:changed', { hostId: 'local' }, 7],
    ]);
  });

  it('does nothing without throwing when the BrowserWindow is destroyed', () => {
    const send = createSafeRendererSender(() => ({
      isDestroyed: () => true,
      // Electron can reject access to webContents after its owner is destroyed.
      get webContents(): never {
        throw new Error('destroyed BrowserWindow webContents was accessed');
      },
    }));

    assert.doesNotThrow(() => send('sessions:changed', { hostId: 'local' }));
  });

  it('does nothing without throwing when webContents is destroyed', () => {
    let sendCalls = 0;
    const send = createSafeRendererSender(() => ({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => true,
        send: () => {
          sendCalls += 1;
          throw new Error('destroyed webContents received a send');
        },
      },
    }));

    assert.doesNotThrow(() => send('sessions:changed', { hostId: 'local' }));
    assert.equal(sendCalls, 0);
  });
});
