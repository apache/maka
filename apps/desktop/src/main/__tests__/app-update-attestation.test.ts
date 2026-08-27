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
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertProductReleaseAttestationSubject,
  productReleaseAttestationName,
  productReleaseAttestationUrl,
  verifyDownloadedUpdateAttestation,
} from '../app-update-attestation.js';

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

test('product attestation location is one version-derived release asset', () => {
  assert.equal(productReleaseAttestationName('1.2.3-beta.1'), 'Maka-1.2.3-beta.1-attestation.sigstore.json');
  assert.equal(
    productReleaseAttestationUrl('1.2.3-beta.1'),
    'https://github.com/apache/maka/releases/download/v1.2.3-beta.1/Maka-1.2.3-beta.1-attestation.sigstore.json',
  );
  assert.throws(() => productReleaseAttestationName('../escape'), /cannot identify/u);
});

test('attestation subject must bind the exact update name and digest', () => {
  const digest = 'a'.repeat(64);
  const bundle = provenanceBundle('Maka-1.2.3-mac-arm64.zip', digest);
  assert.doesNotThrow(() =>
    assertProductReleaseAttestationSubject(bundle, 'Maka-1.2.3-mac-arm64.zip', digest),
  );
  assert.throws(
    () => assertProductReleaseAttestationSubject(bundle, 'Maka-1.2.3-win-x64.exe', digest),
    /does not identify/u,
  );
  assert.throws(
    () => assertProductReleaseAttestationSubject(bundle, 'Maka-1.2.3-mac-arm64.zip', 'b'.repeat(64)),
    /does not identify/u,
  );
});

test('download verification checks cryptography before accepting the exact artifact subject', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-update-attestation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifact = join(directory, 'cached-update.zip');
  const bytes = Buffer.from('attested update bytes');
  await writeFile(artifact, bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const bundle = provenanceBundle('Maka-1.2.3-mac-arm64.zip', digest);
  let cryptographicVerifications = 0;

  await verifyDownloadedUpdateAttestation({
    downloadedFile: artifact,
    version: '1.2.3',
    platform: 'darwin',
    arch: 'arm64',
    trustRootCacheDirectory: join(directory, 'trust'),
    fetchBundle: async (url) => {
      assert.equal(url, productReleaseAttestationUrl('1.2.3'));
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
    verifyBundle: async () => {
      cryptographicVerifications += 1;
    },
  });

  assert.equal(cryptographicVerifications, 1);
});
