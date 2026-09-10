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
import { spawnSync } from 'node:child_process';
import test from 'node:test';

for (const presence of ['removed', 'absent']) {
  for (const kind of ['begin', 'chunk', 'commit', 'abort']) {
    test(`${kind} rejected for a ${presence} Session releases only its owner's staging while idle`, () => {
      const moduleUrl = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
      const result = spawnSync(
        process.execPath,
        [
          '--expose-gc',
          '--input-type=module',
          '-e',
          `
        import assert from 'node:assert/strict';
        import { createHash } from 'node:crypto';
        import { mkdtemp, rm } from 'node:fs/promises';
        import { tmpdir } from 'node:os';
        import { join } from 'node:path';
        import { setImmediate } from 'node:timers/promises';
        import { openInteractiveArtifactStoreForWrite } from '@maka/storage/artifact-stores';
        import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
        import { HostArtifactCoordinator } from ${moduleUrl('../server/artifact-coordinator.js')};
        import { SessionAdmissionGate } from ${moduleUrl('../server/session-admission-gate.js')};

        const root = await mkdtemp(join(tmpdir(), 'maka-artifact-upload-lifetime-'));
        const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
        const owner = await tryAcquireInteractiveRootOwner(capability);
        assert.ok(owner);
        const store = await openInteractiveArtifactStoreForWrite(owner.lease);
        const gate = new SessionAdmissionGate();
        const missing = new Set();
        const coordinator = new HostArtifactCoordinator(
          store, () => assert.fail('unexpected Host drain'), gate,
          { probeSessionRemoval: async id => ({
            kind: missing.has(id) ? ${JSON.stringify(presence)} : 'present',
          }) },
          () => 0, // No TTL sweep can explain reclamation or capacity reuse.
        );
        const context = {
          hostEpoch: 'epoch', connectionId: 'still-open', principal: 'local_os_user',
          acquireResidency: () => ({ release() {} }),
        };
        const ingest = (input, caller = context) => coordinator.handlers['artifact.ingest'](input, caller);
        const MiB = 1024 * 1024;
        const totalBytes = 50 * MiB;
        const chunk = Buffer.alloc(128 * 1024, 7);
        const hash = createHash('sha256');
        for (let offset = 0; offset < totalBytes; offset += chunk.length) hash.update(chunk);
        const begin = {
          kind: 'begin', sessionId: 'target', uploadId: 'upload', name: 'fixture.bin',
          mimeType: 'application/octet-stream', totalBytes,
          contentSha256: 'sha256:' + hash.digest('hex'),
        };
        const rejected = {
          begin,
          chunk: { kind: 'chunk', sessionId: 'target', uploadId: 'upload',
            offset: totalBytes - chunk.length, chunkBase64: chunk.toString('base64') },
          commit: { kind: 'commit', sessionId: 'target', uploadId: 'upload' },
          abort: { kind: 'abort', sessionId: 'target', uploadId: 'upload' },
        }[${JSON.stringify(kind)}];
        const notFound = { ok: false, error: { code: 'not_found', message: 'Session was not found' } };
        const full = { ok: false, error: {
          code: 'operation_conflict', message: 'Attachment upload capacity is exhausted',
        } };
        const probe = { ...begin, sessionId: 'capacity-probe', totalBytes: 1 };
        // Observe only large staging allocations, with no strong reference to their backing stores.
        const backing = [];
        const originalAlloc = Buffer.alloc;
        Buffer.alloc = function (...args) {
          const buffer = Reflect.apply(originalAlloc, Buffer, args);
          if (args[0] === totalBytes || args[0] === 28 * MiB) {
            backing.push(new WeakRef(buffer.buffer));
          }
          return buffer;
        };
        const collect = async () => {
          for (let i = 0; i < 6; i++) { await setImmediate(); global.gc(); }
        };
        try {
          assert.deepEqual(await ingest(begin), {
            ok: true, result: { kind: 'upload_opened', uploadId: 'upload', nextOffset: 0 },
          });
          for (let offset = 0; offset < totalBytes; offset += chunk.length) {
            assert.deepEqual(await ingest({ kind: 'chunk', sessionId: 'target', uploadId: 'upload',
              offset, chunkBase64: chunk.toString('base64') }), {
              ok: true, result: { kind: 'chunk_accepted', uploadId: 'upload',
                nextOffset: offset + chunk.length },
            });
          }
          // Fill the 128 MiB pool; same upload ID in another Session must remain independent.
          assert.equal((await ingest({ ...begin, sessionId: 'other-session' })).ok, true);
          assert.equal((await ingest({ ...begin, uploadId: 'other-upload', totalBytes: 28 * MiB })).ok, true);
          assert.equal(backing.length, 3);
          assert.deepEqual(await ingest(probe), full);
          await collect();
          assert.equal(backing.filter(ref => ref.deref()).length, 3, 'live pool owns all staging');
          await gate.run('target', () => { missing.add('target'); });
          for (const foreign of [
            { ...context, connectionId: 'foreign' },
            { ...context, hostEpoch: 'foreign' },
          ]) {
            assert.deepEqual(await ingest(rejected, foreign), notFound);
            await collect();
            assert.equal(backing.filter(ref => ref.deref()).length, 3,
              'foreign connection or epoch must not free staging');
            assert.deepEqual(await ingest(probe), full);
          }
          assert.deepEqual(await ingest(rejected), notFound);
          // Stay idle with the coordinator and connection alive: no cleanup request or sweep.
          await collect();
          assert.equal(backing[0].deref() === undefined, true, 'rejected owner upload must be collectible');
          assert.ok(backing[1].deref(), 'other Session staging must remain owned');
          assert.ok(backing[2].deref(), 'other upload staging must remain owned');
          assert.deepEqual(await ingest({ kind: 'abort', sessionId: 'target', uploadId: 'upload' }), notFound);
          assert.equal((await store.listPage('target', { offset: 0, limit: 10 })).records.length, 0);
          // Reuse all released bytes on the same connection, without waiting for expiration.
          assert.deepEqual(await ingest({ ...begin, sessionId: 'replacement' }), {
            ok: true, result: { kind: 'upload_opened', uploadId: 'upload', nextOffset: 0 },
          });
          assert.deepEqual(await ingest(probe), full);
          assert.equal((await ingest({ kind: 'abort', sessionId: 'replacement', uploadId: 'upload' })).ok, true);
        } finally {
          Buffer.alloc = originalAlloc;
          coordinator.releaseConnection(context.connectionId);
          await store.close();
          await owner.close();
          await rm(root, { recursive: true, force: true });
        }
      `,
        ],
        { encoding: 'utf8', timeout: 30_000 },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr || result.stdout);
    });
  }
}
