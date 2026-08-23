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
import {
  decodeSessionBundleManifestV1,
  encodeSessionBundleManifestV1,
  SessionBundleFileError,
  type SessionBundleManifestV1,
} from '../index.js';

const manifest: SessionBundleManifestV1 = {
  schemaVersion: 1,
  codec: {
    name: 'maka-session-bundle',
    version: 1,
    canonicalizationVersion: 1,
    archive: 'ustar',
    compression: 'zstd',
    compressionLevel: 3,
  },
  envelope: {
    sessionId: 'cloud-session-α',
    lastCommittedActivationId: 'activation-7',
  },
  stateIdentity: {
    path: 'state-identity.json',
    mediaType: 'application/vnd.maka.session-state-identity+json;version=1',
  },
  payload: {
    statePath: 'state/',
    workspacePath: 'workspace/',
    treeDigest: `sha256:${'ab'.repeat(32)}`,
    payloadBytes: 37,
    entryCount: 5,
  },
};

const canonicalManifestText =
  `{"codec":{"archive":"ustar","canonicalizationVersion":1,"compression":"zstd",` +
  `"compressionLevel":3,"name":"maka-session-bundle","version":1},` +
  `"envelope":{"lastCommittedActivationId":"activation-7","sessionId":"cloud-session-α"},` +
  `"payload":{"entryCount":5,"payloadBytes":37,"statePath":"state/",` +
  `"treeDigest":"sha256:${'ab'.repeat(32)}","workspacePath":"workspace/"},` +
  `"schemaVersion":1,"stateIdentity":{"mediaType":` +
  `"application/vnd.maka.session-state-identity+json;version=1","path":"state-identity.json"}}`;

test('pins canonical Manifest V1 UTF-8 bytes and round-trips them', () => {
  const encoded = encodeSessionBundleManifestV1(manifest);
  assert.equal(new TextDecoder().decode(encoded), canonicalManifestText);
  assert.equal(encoded[0], '{'.charCodeAt(0));
  assert.equal(encoded.at(-1), '}'.charCodeAt(0));
  assert.deepEqual(decodeSessionBundleManifestV1(encoded), manifest);
});

test('omits optional Activation provenance instead of inventing authority', () => {
  const withoutActivation: SessionBundleManifestV1 = {
    ...manifest,
    envelope: { sessionId: manifest.envelope.sessionId },
  };
  const text = new TextDecoder().decode(encodeSessionBundleManifestV1(withoutActivation));
  assert.match(text, /"envelope":\{"sessionId":"cloud-session-α"\}/);
  assert.doesNotMatch(text, /lastCommittedActivationId/);
});

test('does not serialize inherited Activation provenance', () => {
  const envelope = Object.assign(
    Object.create({ lastCommittedActivationId: 'inherited-activation' }) as object,
    { sessionId: manifest.envelope.sessionId },
  ) as SessionBundleManifestV1['envelope'];

  const encoded = encodeSessionBundleManifestV1({ ...manifest, envelope });
  const text = new TextDecoder().decode(encoded);
  assert.match(text, /"envelope":\{"sessionId":"cloud-session-α"\}/);
  assert.doesNotMatch(text, /inherited-activation|lastCommittedActivationId/);
  assert.deepEqual(decodeSessionBundleManifestV1(encoded).envelope, {
    sessionId: manifest.envelope.sessionId,
  });
});

test('rejects parseable but non-canonical manifest bytes', () => {
  const nonCanonical = new TextEncoder().encode(JSON.stringify(manifest));
  assertBundleError(() => decodeSessionBundleManifestV1(nonCanonical), 'invalid_manifest');
  assertBundleError(
    () => decodeSessionBundleManifestV1(new TextEncoder().encode(`${canonicalManifestText}\n`)),
    'invalid_manifest',
  );
  assertBundleError(
    () =>
      decodeSessionBundleManifestV1(
        Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(canonicalManifestText)]),
      ),
    'invalid_manifest',
  );
  assertBundleError(
    () =>
      decodeSessionBundleManifestV1(
        new TextEncoder().encode(
          canonicalManifestText.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
        ),
      ),
    'invalid_manifest',
  );
});

test('does not expose attacker-controlled parser diagnostics', () => {
  assert.throws(
    () =>
      decodeSessionBundleManifestV1(
        new TextEncoder().encode('SECRET_SESSION_TOKEN is not a JSON manifest'),
      ),
    (error) => {
      assert.ok(error instanceof SessionBundleFileError);
      assert.equal(error.code, 'invalid_manifest');
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.message, /SECRET_SESSION_TOKEN/);
      return true;
    },
  );
});

test('rejects control-plane revision and fork authority fields', () => {
  for (const extra of [
    { revision: 'r7' },
    { head: 'r7' },
    { forkedFrom: { sessionId: 'source', revision: 'r6' } },
  ]) {
    assertBundleError(
      () =>
        encodeSessionBundleManifestV1({
          ...manifest,
          ...extra,
        } as SessionBundleManifestV1),
      'invalid_manifest',
    );
  }
});

test('distinguishes unsupported schema and codec versions from malformed manifests', () => {
  assertBundleError(
    () =>
      encodeSessionBundleManifestV1({
        ...manifest,
        schemaVersion: 2,
      } as unknown as SessionBundleManifestV1),
    'unsupported_schema',
  );
  assertBundleError(
    () =>
      encodeSessionBundleManifestV1({
        ...manifest,
        codec: { ...manifest.codec, version: 2 },
      } as unknown as SessionBundleManifestV1),
    'unsupported_codec',
  );
  assertBundleError(
    () =>
      encodeSessionBundleManifestV1({
        ...manifest,
        payload: {
          ...manifest.payload,
          treeDigest: `sha256:${'AB'.repeat(32)}`,
        },
      } as SessionBundleManifestV1),
    'invalid_manifest',
  );
});

test('rejects unknown nested fields, invalid Unicode, and incomplete layouts', () => {
  assertBundleError(
    () =>
      encodeSessionBundleManifestV1({
        ...manifest,
        payload: { ...manifest.payload, revision: 'r7' },
      } as SessionBundleManifestV1),
    'invalid_manifest',
  );
  assertBundleError(
    () =>
      encodeSessionBundleManifestV1({
        ...manifest,
        envelope: { sessionId: '\ud800' },
      }),
    'invalid_manifest',
  );
  assertBundleError(
    () =>
      encodeSessionBundleManifestV1({
        ...manifest,
        payload: { ...manifest.payload, entryCount: 2 },
      }),
    'invalid_manifest',
  );
});

function assertBundleError(action: () => unknown, code: SessionBundleFileError['code']): void {
  assert.throws(action, (error) => {
    assert.ok(error instanceof SessionBundleFileError);
    assert.equal(error.code, code);
    return true;
  });
}
