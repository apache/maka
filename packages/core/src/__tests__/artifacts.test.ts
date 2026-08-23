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
import { describe, test } from 'node:test';
import {
  ARTIFACT_ENTITY_ID_MAX_CHARS,
  ARTIFACT_TURN_KEY_MAX_CHARS,
  canUserDeleteArtifact,
  isArtifactTurnKey,
  isCanonicalArtifactEntityId,
} from '../artifacts.js';

describe('canonical Artifact entity identity', () => {
  test('accepts the shared ASCII grammar through the 128-character boundary', () => {
    assert.equal(ARTIFACT_ENTITY_ID_MAX_CHARS, 128);
    assert.equal(isCanonicalArtifactEntityId('Artifact_01-session'), true);
    assert.equal(isCanonicalArtifactEntityId('a'.repeat(ARTIFACT_ENTITY_ID_MAX_CHARS)), true);
  });

  test('rejects values outside the canonical grammar', () => {
    for (const value of ['', 'a'.repeat(ARTIFACT_ENTITY_ID_MAX_CHARS + 1), 'artifact/id', null]) {
      assert.equal(isCanonicalArtifactEntityId(value), false, JSON.stringify(value));
    }
  });
});

describe('Artifact turn key', () => {
  test('accepts bounded opaque turn keys without coupling to synthetic namespaces', () => {
    assert.equal(isArtifactTurnKey('未来:sequence/分支'), true);
    assert.equal(isArtifactTurnKey('x'.repeat(ARTIFACT_TURN_KEY_MAX_CHARS)), true);
  });

  test('rejects empty, unbounded, and control-bearing turn keys', () => {
    for (const value of ['', 'turn\n1', 'x'.repeat(ARTIFACT_TURN_KEY_MAX_CHARS + 1), null]) {
      assert.equal(isArtifactTurnKey(value), false, JSON.stringify(value));
    }
  });
});

describe('Artifact user-delete policy', () => {
  test('protects durable evidence while allowing ordinary and unattributed artifacts', () => {
    assert.equal(canUserDeleteArtifact({ source: 'deep_research' }), false);
    assert.equal(canUserDeleteArtifact({ source: 'user_upload' }), true);
    assert.equal(canUserDeleteArtifact({ source: undefined }), true);
  });
});
