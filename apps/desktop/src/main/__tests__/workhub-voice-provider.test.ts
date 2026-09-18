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
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { getWorkHubVoiceProvider, registerWorkHubVoiceProvider, type WorkHubVoiceProvider } from '../workhub-voice-provider.js';
import { registerWorkHubVoice } from '../workhub-voice.js';
import type { DesktopRuntimeHostClient } from '../runtime-host-client.js';

test('provider registration is explicit, exclusive and disposable', () => {
  assert.equal(getWorkHubVoiceProvider(), undefined);
  const provider: WorkHubVoiceProvider = { id: 'test', dataChannelLabel: 'test-control', create: () => { throw new Error('not connected'); } };
  const dispose = registerWorkHubVoiceProvider(provider);
  try {
    assert.equal(getWorkHubVoiceProvider(), provider);
    assert.throws(() => registerWorkHubVoiceProvider(provider), /already registered/);
  } finally { dispose(); }
  assert.equal(getWorkHubVoiceProvider(), undefined);
  const next = { ...provider, id: 'next' };
  const disposeNext = registerWorkHubVoiceProvider(next);
  try { dispose(); assert.equal(getWorkHubVoiceProvider(), next); } finally { disposeNext(); }
});

test('without a provider capture preparation fails without starting a host session', async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const client = new Proxy({}, { get: () => { throw new Error('Host must not be touched'); } }) as DesktopRuntimeHostClient;
  const close = registerWorkHubVoice(client, { handle: (name, handler) => { handlers.set(name, handler); } });
  try {
    assert.throws(() => handlers.get('workhub:voice:prepare')!({ sender: new EventEmitter() }), /No voice provider is installed/);
  } finally { close(); }
});
