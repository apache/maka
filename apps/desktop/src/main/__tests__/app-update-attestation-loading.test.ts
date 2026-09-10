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
import { test } from 'node:test';

test('channel helpers defer Sigstore loading until parsing and default verification', () => {
  // A fresh process prevents earlier tests' module caches from hiding eager imports.
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', String.raw`
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
    import { createRequire, Module } from 'node:module';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';

    const moduleUrl = process.argv[1];
    const require = createRequire(moduleUrl);
    const trustPackagePattern = new RegExp('/node_modules/(?:@sigstore|@tufjs|tuf-js)/', 'u');
    const loadedTrustModules = () => Object.keys(require.cache).filter((path) =>
      trustPackagePattern.test(path.replaceAll(String.fromCharCode(92), '/')));
    assert.deepEqual(loadedTrustModules(), []);
    const {
      desktopDiagnosticUpdateChannel,
      desktopUpdateChannelFromManifest,
      verifyDownloadedUpdateAttestation,
    } = await import(moduleUrl);
    const directory = mkdtempSync(join(tmpdir(), 'maka-attestation-loading-'));
    globalThis.fetch = async () => { throw new Error('unexpected network request'); };
    try {
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ makaUpdateChannel: 'nightly' }));
      assert.equal(desktopDiagnosticUpdateChannel({ isPackaged: true, appPath: directory }), 'nightly');
      assert.equal(desktopDiagnosticUpdateChannel({ isPackaged: false, appPath: directory }), 'dev');
      assert.equal(desktopUpdateChannelFromManifest({ makaUpdateChannel: 'release' }), 'release');
      assert.throws(() => desktopUpdateChannelFromManifest({}), /trusted update channel/u);
      assert.deepEqual(loadedTrustModules(), [], 'channel helpers must not load Sigstore or TUF');

      const name = 'Maka-1.2.3-linux-amd64.deb';
      const downloadedFile = join(directory, name);
      const artifact = Buffer.from('downloaded update fixture');
      writeFileSync(downloadedFile, artifact);
      const statement = {
        _type: 'https://in-toto.io/Statement/v1',
        predicateType: 'https://slsa.dev/provenance/v1',
        subject: [{ name, digest: { sha256: createHash('sha256').update(artifact).digest('hex') } }],
      };
      const bytes = Buffer.from(JSON.stringify({
        mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
        verificationMaterial: {
          certificate: { rawBytes: Buffer.from('fixture certificate').toString('base64') },
          tlogEntries: [],
        },
        dsseEnvelope: {
          payloadType: 'application/vnd.in-toto+json',
          payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
          signatures: [{ sig: Buffer.from('fixture signature').toString('base64') }],
        },
      }));
      const options = {
        downloadedFile, version: '1.2.3', platform: 'linux', files: [{ url: name }],
        trustRootCacheDirectory: join(directory, 'trust'), fetchBundle: async () => bytes,
      };
      await assert.rejects(verifyDownloadedUpdateAttestation({ ...options, files: [] }), /feed offered/u);
      await assert.rejects(verifyDownloadedUpdateAttestation({
        ...options, fetchBundle: async () => Buffer.from('invalid JSON'),
      }), /not valid JSON/u);
      assert.deepEqual(loadedTrustModules(), [], 'rejected input must not load trust packages');

      let parsedBundle;
      await verifyDownloadedUpdateAttestation({
        ...options, verifyBundle: async (bundle) => { parsedBundle = bundle; },
      });
      assert.equal(parsedBundle.content.$case, 'dsseEnvelope');
      assert.deepEqual(JSON.parse(Buffer.from(parsedBundle.content.dsseEnvelope.payload)), statement);
      assert.ok(require.cache[require.resolve('@sigstore/bundle')], 'first parse loads the real parser');
      assert.equal(require.cache[require.resolve('@sigstore/tuf')], undefined);
      assert.equal(require.cache[require.resolve('@sigstore/verify')], undefined);

      // Stub only the trust-root request first: no network, but load the real verifier.
      const installStub = (specifier, exports) => {
        const id = require.resolve(specifier);
        const module = new Module(id);
        module.exports = exports;
        module.loaded = true;
        require.cache[id] = module;
      };
      const rootFailure = new Error('trust-root retrieval failed');
      installStub('@sigstore/tuf', { getTrustedRoot: async (input) => {
        assert.deepEqual(input, { cachePath: options.trustRootCacheDirectory, timeout: 10_000 });
        throw rootFailure;
      } });
      await assert.rejects(verifyDownloadedUpdateAttestation(options), (error) => error === rootFailure);
      assert.ok(require.cache[require.resolve('@sigstore/verify')], 'default verification loads verifier');

      // Exercise identity forwarding and failure propagation without replacing the
      // existing packaged-Electron cryptographic tests with synthetic signatures.
      const trustedRoot = {};
      const trustMaterial = {};
      const signedEntity = {};
      let verificationFailure;
      let expectedWorkflow = '.github/workflows/release-cli-finalize.yml';
      let verificationCalls = 0;
      installStub('@sigstore/tuf', { getTrustedRoot: async () => trustedRoot });
      installStub('@sigstore/verify', {
        toTrustMaterial: (root) => { assert.equal(root, trustedRoot); return trustMaterial; },
        toSignedEntity: (bundle) => {
          assert.equal(bundle.content.$case, 'dsseEnvelope');
          return signedEntity;
        },
        Verifier: class {
          constructor(material) { assert.equal(material, trustMaterial); }
          verify(entity, identity) {
            verificationCalls++;
            assert.equal(entity, signedEntity);
            assert.deepEqual(identity.extensions, { issuer: 'https://token.actions.githubusercontent.com' });
            const signer = 'https://github.com/apache/maka/' + expectedWorkflow + '@refs/heads/main';
            assert.ok(identity.subjectAlternativeName.test(signer));
            assert.equal(identity.subjectAlternativeName.test(signer + '/extra'), false);
            assert.equal(identity.subjectAlternativeName.test(signer.replace('apache/maka', 'other/maka')), false);
            assert.equal(identity.subjectAlternativeName.test(signer.replace('heads/main', 'heads/other')), false);
            if (verificationFailure) throw verificationFailure;
          }
        },
      });
      await verifyDownloadedUpdateAttestation(options);
      expectedWorkflow = '.github/workflows/desktop-nightly.yml';
      await verifyDownloadedUpdateAttestation({ ...options, channel: 'nightly' });
      expectedWorkflow = '.github/workflows/release-cli-finalize.yml';
      verificationFailure = new Error('signature verification failed');
      await assert.rejects(verifyDownloadedUpdateAttestation(options), (error) => error === verificationFailure);
      verificationFailure = undefined;
      writeFileSync(downloadedFile, 'tampered update');
      await assert.rejects(verifyDownloadedUpdateAttestation(options), /does not identify the downloaded artifact/u);
      assert.equal(verificationCalls, 4);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  `, new URL('../app-update-attestation.js', import.meta.url).href], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
