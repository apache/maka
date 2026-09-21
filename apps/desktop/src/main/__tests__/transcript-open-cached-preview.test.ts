import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
import type { StoredMessage } from '@maka/core/session';
import type { MakaBridge } from '../../preload/bridge-contract.js';
import type { DesktopTranscriptBatch } from '../../preload/transcript-contract.js';
import { encodeDesktopTranscriptSnapshot } from '../desktop-transcript-ipc.js';
import { DesktopTranscriptRangeStore } from '../../renderer/platform/desktop/desktop-transcript-range-store.js';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';
import { waitFor } from '@maka/core/test-only/async-primitives';

// transcripts.open replays the locally cached tail before the live history
// answer so the previous content is visible while the Host reads. That preview
// must never advertise earlier history: nothing can answer the read until the
// live generation replaces it.
test('the cached preview publishes no earlier history before the live answer replaces it', async () => {
  const owner = {
    hostId: 'host-1', targetEpoch: 'epoch-1', profileId: 'local',
    profileName: 'Local', profileKind: 'local', profileAccess: 'owner', readiness: 'ready',
  };
  const sessionId = desktopSessionKey({ hostId: owner.hostId, sessionId: 'session-1' });
  const message = (id: string, turnId: string): StoredMessage => ({
    type: 'user', id, turnId, ts: 1, text: id,
  });
  const cachedTail = [
    { sequence: 19, message: message('m19', 't19') },
    { sequence: 20, message: message('m20', 't20') },
  ];
  const full = Array.from({ length: 20 }, (_, index) => ({
    sequence: index + 1, message: message(`m${index + 1}`, `t${index + 1}`),
  }));
  let bridge: MakaBridge | undefined;
  let consumerId = '';
  let deliverySequence = 0;
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const deliver = (batch: Omit<DesktopTranscriptBatch, 'deliverySequence'>) => {
    listeners.get(`sessions:transcript:${consumerId}`)?.({}, owner, {
      ...batch, deliverySequence: ++deliverySequence,
    });
  };
  const ipcRenderer = {
    on(channel: string, listener: (...args: unknown[]) => void) { listeners.set(channel, listener); },
    off(channel: string) { listeners.delete(channel); },
    send() {},
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      if (channel === 'runtime-host:activeIdentity') return owner;
      if (channel === 'runtime-host:identities') return [owner];
      if (channel === 'session-local:transcript') {
        return {
          cachedAt: 1,
          batches: [...encodeDesktopTranscriptSnapshot({
            beginsAtTurnBoundary: true,
            sessionId: 'session-1', generation: 'cached:g1', hostEpoch: 'epoch-1',
            durableThrough: 20, durable: cachedTail, hasOlder: true,
          })],
        };
      }
      if (channel === 'sessions:transcript:open') {
        consumerId = args[2] as string;
        setImmediate(() => {
          for (const batch of encodeDesktopTranscriptSnapshot({
            beginsAtTurnBoundary: true,
            sessionId: 'session-1', generation: 'live-1', hostEpoch: 'epoch-1',
            durableThrough: 20, durable: full, hasOlder: false,
          })) deliver(batch);
        });
        return { kind: 'ready', value: {
          sessionId: 'session-1', generation: 'live-1', hostEpoch: 'epoch-1',
          readThroughMessageId: null,
        } };
      }
      if (
        channel === 'sessions:transcript:ack' ||
        channel === 'sessions:transcript:acknowledge-tail' ||
        channel === 'sessions:transcript:close'
      ) return;
      throw new Error(`Unexpected channel: ${channel}`);
    },
  };
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../../../src/preload/preload.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['electron'],
  });
  const require = createRequire(import.meta.url);
  runInNewContext(bundle.outputFiles[0]!.text, {
    require: (id: string) => id === 'electron' ? {
      ipcRenderer,
      contextBridge: { exposeInMainWorld(name: string, value: MakaBridge) {
        if (name === 'maka') bridge = value;
      } },
    } : require(id),
    process: { env: {} }, Buffer, console, setTimeout, clearTimeout, TextEncoder, TextDecoder,
    Uint8Array, crypto: globalThis.crypto,
  });
  assert.ok(bridge);

  const store = new DesktopTranscriptRangeStore(sessionId);
  const publications: Array<{ ids: string[]; hasOlder: boolean }> = [];
  store.subscribe(() => {
    const snapshot = store.snapshot();
    if (snapshot.ready) {
      publications.push({
        ids: snapshot.messages.map((entry) => entry.id),
        hasOlder: snapshot.hasOlder,
      });
    }
  });
  const handle = await bridge.transcripts.open(
    sessionId,
    (batch) => store.accept(batch),
    () => {},
    'history',
  );
  await waitFor(() => publications.length === 2, { timeoutMs: 5_000 });
  await handle.close();

  assert.deepEqual(publications, [
    { ids: ['m19', 'm20'], hasOlder: false },
    { ids: full.map((entry) => entry.message.id), hasOlder: false },
  ]);
});
