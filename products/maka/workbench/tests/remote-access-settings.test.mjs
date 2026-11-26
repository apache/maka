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
import { registerHooks } from 'node:module';
import test from 'node:test';

const fixtures = {
  nsh: `export function signal(value) {
    return Object.assign(() => value, { set(next) { value = next; } });
  }
  export const platform = { idiom: 'desktop' };
  export const Clipboard = { writeText: (value) => globalThis.remoteFixture.copy(value) };`,
  'maka/host':
    'export const host = new Proxy({}, { get: (_, key) => globalThis.remoteFixture[key] });',
  './locale': 'export const tr = (key) => key;',
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (Object.hasOwn(fixtures, specifier)) {
      return {
        url: 'data:text/javascript,' + encodeURIComponent(fixtures[specifier]),
        shortCircuit: true,
      };
    }
    if (specifier === './pairingQr' || specifier === './settingsDiscard')
      return next(specifier + '.ts', context);
    return next(specifier, context);
  },
});
const { createRemoteAccessSettings } = await import('../app/remoteAccessSettingsState.ts');
hooks.deregister();

const started = 1_900_000_000_000;
const flush = () => new Promise((done) => setImmediate(done));
const peer = { peerId: 'phone', label: 'Phone' };

async function setup(t, ttl = 300_000) {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: started });
  let next = {
    config: {
      enabled: true,
      relayOnly: true,
      relays: [
        {
          endpoint: { url: 'https://relay.example.org/', quicPort: null, certSha256: null },
          caDerPath: null,
          hasAuthToken: true,
        },
      ],
    },
    status: 'connected',
    connectedRelays: ['https://relay.example.org/'],
    sas: null,
  };
  let devices = [];
  let hung = false;
  let pending = true;
  const polled = [];
  const writes = [];
  const copies = [];
  globalThis.remoteFixture = {
    remoteAccessStatus: async (inviteId) => {
      polled.push(inviteId);
      if (hung) return new Promise(() => {});
      return {
        ...next,
        inviteState:
          inviteId !== 'invite'
            ? null
            : !pending
              ? 'consumed'
              : Date.now() >= started + ttl
                ? 'expired'
                : 'pending',
      };
    },
    normalizeRemoteRelayUrl: (url) => {
      try {
        return new URL(url).href;
      } catch {
        return null;
      }
    },
    updateRemoteAccess: async (value, tokens) => {
      writes.push({ value, tokens });
      return next.config;
    },
    listPairedDevices: async () => devices,
    prepareDevicePairing: async () => ({
      inviteId: 'invite',
      uri: 'maka://pair/v1?payload=test',
      expiresAtMs: started + ttl,
    }),
    copy: async (value) => {
      copies.push(value);
    },
  };
  const owner = createRemoteAccessSettings();
  owner.activate();
  await flush();
  t.after(() => {
    owner.deactivate();
    delete globalThis.remoteFixture;
  });
  return {
    owner,
    copies,
    polled,
    writes,
    config: (change) => {
      next = { ...next, config: { ...next.config, ...change } };
    },
    sas: () => {
      next = { ...next, sas: { peerId: peer.peerId, sas: '123456', at: Date.now() } };
    },
    addPeer: () => {
      devices = [peer];
    },
    redeem: () => {
      pending = false;
      devices = [peer];
    },
    hang: () => {
      hung = true;
    },
  };
}

test('refreshes a clean draft on Host changes without overwriting local edits', async (t) => {
  const { owner, config } = await setup(t);
  config({ enabled: false });
  await owner.refresh();
  assert.equal(owner.draft().enabled, false);
  owner.setEnabled(true);
  config({ relayOnly: false });
  await owner.refresh();
  assert.equal(owner.draft().enabled, true);
  assert.equal(owner.draft().relayOnly, true);
  owner.discard();
  assert.equal(owner.draft().enabled, false);
  assert.equal(owner.draft().relayOnly, false);
});

for (const [label, ttl, advance] of [
  ['the 120-second SAS window', 300_000, 120_000],
  ['the pairing invitation', 30_000, 30_000],
]) {
  test(`clears live SAS at expiry of ${label} even if polling hangs`, async (t) => {
    const { owner, sas, hang } = await setup(t, ttl);
    sas();
    await owner.refresh();
    assert.equal(owner.sas(), null, 'a handshake alone must not be shown');
    t.mock.timers.tick(1);
    owner.pair();
    await flush();
    assert.equal(owner.sas(), null, 'an earlier handshake does not belong to a new invite');
    sas();
    await owner.refresh();
    assert.equal(owner.sas()?.sas, '123456');
    hang();
    t.mock.timers.tick(advance);
    assert.equal(owner.sas(), null);
  });
}

test('clears a redeemed QR without any SAS notice', async (t) => {
  const { owner, redeem } = await setup(t);
  owner.pair();
  await flush();
  assert.ok(owner.activeInvite()?.qr);
  assert.equal(owner.sas(), null);
  redeem();
  await owner.refresh();
  assert.equal(owner.activeInvite(), null);
  assert.equal(owner.pairing().kind, 'idle');
});

test('shows a handshake alongside the QR and does not infer redemption from peer changes', async (t) => {
  const { owner, sas, addPeer, redeem } = await setup(t);
  owner.pair();
  await flush();
  sas();
  addPeer();
  await owner.refresh();
  assert.equal(owner.sas()?.sas, '123456');
  assert.ok(owner.activeInvite()?.qr);
  redeem();
  await owner.refresh();
  assert.equal(owner.sas(), null);
  assert.equal(owner.activeInvite(), null);
});

test('copy provides transient feedback without making the settings busy', async (t) => {
  const { owner, copies } = await setup(t);
  const copying = owner.copy('peer', 'full-peer-id');
  assert.equal(owner.busy(), false);
  await copying;
  assert.deepEqual(copies, ['full-peer-id']);
  assert.equal(owner.copied(), 'peer');
  t.mock.timers.tick(2000);
  assert.equal(owner.copied(), '');
});

test('live polling keeps the expired state and stops querying its invite ID', async (t) => {
  const { owner, polled } = await setup(t, 2000);
  owner.pair();
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(polled.at(-1), 'invite');
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(owner.pairing().kind, 'expired');
    assert.equal(owner.activeInvite(), null);
    assert.equal(polled.at(-1), null);
  }
});

test('relay token actions follow normalized URL identity, not the edited row', async (t) => {
  const { owner, writes } = await setup(t);
  const relay = () => owner.draft().relays[0];
  const id = relay().id;
  owner.editRelay(id, { auth: 'clear' });
  owner.editRelay(id, { url: ' https://RELAY.example.org:443 ' });
  assert.equal(owner.hasSavedToken(relay()), true);
  assert.equal(owner.relayAuth(relay()), 'clear');
  owner.editRelay(id, { url: 'https://relay.example.org:8443' });
  assert.equal(owner.hasSavedToken(relay()), false);
  assert.equal(owner.relayAuth(relay()), 'keep');
  owner.editRelay(id, { auth: 'replace', token: 'for-that-url-only' });
  owner.editRelay(id, { url: 'https://other.example.org' });
  owner.save();
  await flush();
  assert.equal(writes[0].value.relays[0].auth.kind, 'keep');
  assert.deepEqual(writes[0].tokens, [null]);
});
