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
  assertSessionBundleLimits,
  copyOpaqueStateIdentityDescriptor,
  isSha256Digest,
  isValidUnicodeString,
  SESSION_BUNDLE_LIMIT_NAMES,
  SessionBundleFileError,
  type SessionBundleLimits,
} from '../index.js';

const limits: SessionBundleLimits = {
  maxCompressedBytes: 0,
  maxDecompressedTarBytes: 0,
  maxPayloadBytes: 0,
  maxFileBytes: 0,
  maxEntryCount: 0,
  maxManifestBytes: 0,
  maxStateIdentityBytes: 0,
  maxPathBytes: 0,
  maxPathDepth: 0,
};

test('exposes strict lowercase SHA-256 digest validation', () => {
  const digest = `sha256:${'ab'.repeat(32)}`;
  assert.equal(isSha256Digest(digest), true);
  assert.equal(isSha256Digest(`sha256:${'AB'.repeat(32)}`), false);
  assert.equal(isSha256Digest(`sha256:${'ab'.repeat(31)}`), false);
  assert.equal(isSha256Digest(`sha512:${'ab'.repeat(32)}`), false);
  assert.equal(isSha256Digest(42), false);
});

test('validates Unicode strings safely at the runtime boundary', () => {
  assert.equal(isValidUnicodeString('session-🚀'), true);
  assert.equal(isValidUnicodeString('\ud800'), false);
  assert.equal(isValidUnicodeString('\udc00'), false);
  assert.equal(isValidUnicodeString(42), false);
  assert.equal(isValidUnicodeString(null), false);
  assert.equal(isValidUnicodeString({}), false);
});

test('requires every explicit quota while permitting a fail-closed zero budget', () => {
  assert.doesNotThrow(() => assertSessionBundleLimits(limits));
  assert.deepEqual([...SESSION_BUNDLE_LIMIT_NAMES].sort(), Object.keys(limits).sort());

  const missing = { ...limits } as Record<string, number>;
  delete missing.maxPathDepth;
  assert.throws(
    () => assertSessionBundleLimits(missing as unknown as SessionBundleLimits),
    TypeError,
  );
  assert.throws(
    () =>
      assertSessionBundleLimits({
        ...limits,
        maxPathDepth: -1,
      }),
    RangeError,
  );
  assert.throws(
    () =>
      assertSessionBundleLimits({
        ...limits,
        maxPathDepth: 1.5,
      }),
    RangeError,
  );
  assert.throws(
    () =>
      assertSessionBundleLimits({
        ...limits,
        unexpected: 1,
      } as SessionBundleLimits),
    TypeError,
  );
});

test('copies opaque state identity bytes without interpreting or aliasing them', () => {
  const source = new Uint8Array([0, 255, 123, 34, 0, 10]);
  const copied = copyOpaqueStateIdentityDescriptor({
    mediaType: 'application/vnd.maka.session-state-identity+json;version=1',
    bytes: source,
  });

  assert.equal(copied.mediaType, 'application/vnd.maka.session-state-identity+json;version=1');
  assert.deepEqual(copied.bytes, source);
  assert.notEqual(copied.bytes, source);

  source[0] = 99;
  assert.equal(copied.bytes[0], 0);

  assert.throws(
    () => copyOpaqueStateIdentityDescriptor(null as unknown as typeof copied),
    TypeError,
  );
  assert.throws(
    () =>
      copyOpaqueStateIdentityDescriptor({
        mediaType: '\ud800',
        bytes: new Uint8Array(),
      }),
    TypeError,
  );
});

test('keeps stable bundle failures bounded and preserves their causes', () => {
  const cause = new Error('filesystem failure');
  const error = new SessionBundleFileError('io_failure', 'Session bundle I/O failed', {
    cause,
    details: {
      operation: 'inspect',
      quota: 'maxCompressedBytes',
      limit: 10,
      observed: 11,
    },
  });

  assert.equal(error.name, 'SessionBundleFileError');
  assert.equal(error.code, 'io_failure');
  assert.equal(error.cause, cause);
  assert.deepEqual(error.details, {
    operation: 'inspect',
    quota: 'maxCompressedBytes',
    limit: 10,
    observed: 11,
  });
  assert.equal(Object.isFrozen(error.details), true);
});
