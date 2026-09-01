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

import type { Bundle } from '@sigstore/bundle';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  desktopUpdateChannelFromManifest,
  verifyDownloadedUpdateAttestation,
} from '../app-update-attestation.js';

const require = createRequire(import.meta.url);

function assertElectronVerification(script: string, failureMessage: string): void {
  const verification = spawnSync(require('electron') as string, ['-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  assert.equal(
    verification.status,
    0,
    `${failureMessage}:\n${verification.stderr || verification.stdout}`,
  );
}

function provenanceBundle(name: string, sha256: string): Bundle {
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name, digest: { sha256 } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {},
  };
  return {
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    verificationMaterial: {
      content: undefined,
      tlogEntries: [],
      timestampVerificationData: undefined,
    },
    content: {
      $case: 'dsseEnvelope',
      dsseEnvelope: {
        payloadType: 'application/vnd.in-toto+json',
        payload: Buffer.from(JSON.stringify(statement)),
        signatures: [],
      },
    },
  } as unknown as Bundle;
}

test('download verification accepts only a trusted exact artifact subject', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-update-attestation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifact = join(directory, 'cached-update.zip');
  const bytes = Buffer.from('attested update bytes');
  await writeFile(artifact, bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const bundle = provenanceBundle('Maka-1.2.3-mac-arm64.zip', digest);
  const bundleBytes = Buffer.from(JSON.stringify({
    mediaType: bundle.mediaType,
    verificationMaterial: {
      certificate: { rawBytes: Buffer.from('fixture certificate').toString('base64') },
      tlogEntries: [],
    },
    dsseEnvelope: {
      payloadType: bundle.content.$case === 'dsseEnvelope'
        ? bundle.content.dsseEnvelope.payloadType
        : '',
      payload: bundle.content.$case === 'dsseEnvelope'
        ? Buffer.from(bundle.content.dsseEnvelope.payload).toString('base64')
        : '',
      signatures: [{ sig: Buffer.from('fixture signature').toString('base64') }],
    },
  }));
  const options = {
    downloadedFile: artifact,
    version: '1.2.3',
    platform: 'darwin' as const,
    arch: 'arm64',
    trustRootCacheDirectory: join(directory, 'trust'),
    fetchBundle: async () => bundleBytes,
    verifyBundle: async () => {},
  };

  await verifyDownloadedUpdateAttestation(options);
  await assert.rejects(
    verifyDownloadedUpdateAttestation({ ...options, platform: 'win32', arch: 'x64' }),
    /does not identify/u,
  );

  await writeFile(artifact, 'different update bytes');
  await assert.rejects(verifyDownloadedUpdateAttestation(options), /does not identify/u);

  await assert.rejects(
    verifyDownloadedUpdateAttestation({
      ...options,
      verifyBundle: () => {
        throw new Error('untrusted workflow identity');
      },
    }),
    /untrusted workflow identity/u,
  );
});

test('nightly verification fetches provenance from the versioned GitHub Release asset', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-nightly-attestation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifact = join(directory, 'cached-update.zip');
  const bytes = Buffer.from('nightly update bytes');
  await writeFile(artifact, bytes);
  const version = '0.2.0-dev.20260829.42';
  const name = `Maka-${version}-mac-arm64.zip`;
  const digest = createHash('sha256').update(bytes).digest('hex');
  const bundle = provenanceBundle(name, digest);
  let fetchedUrl = '';

  await verifyDownloadedUpdateAttestation({
    channel: 'nightly',
    downloadedFile: artifact,
    version,
    platform: 'darwin',
    arch: 'arm64',
    trustRootCacheDirectory: join(directory, 'trust'),
    fetchBundle: async (url) => {
      fetchedUrl = url;
      return Buffer.from(JSON.stringify({
        mediaType: bundle.mediaType,
        verificationMaterial: {
          certificate: { rawBytes: Buffer.from('fixture certificate').toString('base64') },
          tlogEntries: [],
        },
        dsseEnvelope: {
          payloadType: bundle.content.$case === 'dsseEnvelope'
            ? bundle.content.dsseEnvelope.payloadType
            : '',
          payload: bundle.content.$case === 'dsseEnvelope'
            ? Buffer.from(bundle.content.dsseEnvelope.payload).toString('base64')
            : '',
          signatures: [{ sig: Buffer.from('fixture signature').toString('base64') }],
        },
      }));
    },
    verifyBundle: async () => {},
  });

  assert.equal(
    fetchedUrl,
    `https://github.com/apache/maka/releases/download/v${version}/Maka-${version}-attestation.sigstore.json`,
  );
});

test('packaged update trust accepts only an explicit release or nightly channel', () => {
  assert.equal(desktopUpdateChannelFromManifest({ makaUpdateChannel: 'release' }), 'release');
  assert.equal(desktopUpdateChannelFromManifest({ makaUpdateChannel: 'nightly' }), 'nightly');
  assert.throws(
    () => desktopUpdateChannelFromManifest({ makaUpdateChannel: 'preview' }),
    /does not declare a trusted update channel/u,
  );
});

test('TUF verifies ECDSA without breaking Ed25519 in the packaged Electron runtime', () => {
  assertElectronVerification(
    String.raw`
        const { generateKeyPairSync, sign } = require('node:crypto');
        const { dirname, join } = require('node:path');
        const modelsEntry = require.resolve('@tufjs/models');
        const { canonicalize } = require('@tufjs/canonical-json');
        const { verifySignature } = require(join(dirname(modelsEntry), 'utils', 'verify.js'));
        const metadata = { _type: 'root', expires: '2030-01-01T00:00:00Z', version: 1 };
        const data = Buffer.from(canonicalize(metadata));
        for (const { type, options, algorithm } of [
          { type: 'ec', options: { namedCurve: 'prime256v1' }, algorithm: 'sha256' },
          { type: 'ed25519', options: {}, algorithm: null },
        ]) {
          const { privateKey, publicKey } = generateKeyPairSync(type, options);
          const signature = sign(algorithm, data, privateKey).toString('hex');
          if (!verifySignature(metadata, { key: publicKey }, signature)) process.exit(1);
        }
      `,
    'Electron TUF verification failed',
  );
});

test('Sigstore verifies ECDSA without breaking Ed25519 in the packaged Electron runtime', () => {
  assertElectronVerification(
    String.raw`
        const { generateKeyPairSync, sign } = require('node:crypto');
        const { crypto } = require('@sigstore/core');
        const data = Buffer.from('signed update metadata');
        for (const { type, options, algorithm } of [
          { type: 'ec', options: { namedCurve: 'prime256v1' }, algorithm: 'sha256' },
          { type: 'ed25519', options: {}, algorithm: null },
        ]) {
          const { privateKey, publicKey } = generateKeyPairSync(type, options);
          const signature = sign(algorithm, data, privateKey);
          if (!crypto.verify(data, publicKey, signature)) process.exit(1);
        }
        if (crypto.verify(data, 'not a public key', Buffer.alloc(0))) process.exit(1);
      `,
    'Electron Sigstore verification failed',
  );
});
