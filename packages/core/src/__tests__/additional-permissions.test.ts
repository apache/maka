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

import { describe, test } from 'node:test';
import { expect } from './test-helpers.js';
import {
  compactAdditionalFileSystemPermissions,
  serializeAdditionalPermissionProfile,
  validateAdditionalPermissionProfile,
  type AdditionalPermissionProfile,
} from '../additional-permissions.js';

describe('AdditionalPermissionProfile validation', () => {
  test('accepts and canonicalizes a minimal filesystem permission', () => {
    const result = validateAdditionalPermissionProfile({
      fileSystem: {
        entries: [{ path: '/outside/file.txt', access: 'write', scope: 'exact' }],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile).toEqual({
      fileSystem: {
        entries: [{ path: '/outside/file.txt', access: 'write', scope: 'exact' }],
      },
    });
  });

  test('accepts one-command network enable', () => {
    expect(validateAdditionalPermissionProfile({ network: { enabled: true } })).toEqual({
      ok: true,
      profile: { network: { enabled: true } },
    });
  });

  test('rejects empty, relative, malformed, and policy-shaped profiles', () => {
    for (const profile of [
      {},
      { fileSystem: { entries: [] } },
      { fileSystem: { entries: [{ path: '../outside', access: 'read', scope: 'exact' }] } },
      { fileSystem: { entries: [{ path: '/outside', access: 'deny', scope: 'exact' }] } },
      { fileSystem: { entries: [{ path: '/outside', access: 'read', scope: 'special' }] } },
      {
        fileSystem: {
          entries: [{ path: '/outside', access: 'read', scope: 'exact', kind: 'path' }],
        },
      },
      { network: { enabled: false } },
      { type: 'managed', network: { enabled: true } },
    ]) {
      expect(validateAdditionalPermissionProfile(profile).ok).toBe(false);
    }
  });

  test('compacts covered and duplicate entries deterministically', () => {
    expect(
      compactAdditionalFileSystemPermissions([
        { path: '/outside/tree/file.txt', access: 'read', scope: 'exact' },
        { path: '/outside/tree', access: 'read', scope: 'subtree' },
        { path: '/outside/tree', access: 'read', scope: 'subtree' },
        { path: '/outside/write.txt', access: 'read', scope: 'exact' },
        { path: '/outside/write.txt', access: 'write', scope: 'exact' },
      ]),
    ).toEqual([
      { path: '/outside/tree', access: 'read', scope: 'subtree' },
      { path: '/outside/write.txt', access: 'write', scope: 'exact' },
    ]);
  });

  test('canonical serialization is stable across input order', () => {
    const first: AdditionalPermissionProfile = {
      fileSystem: {
        entries: [
          { path: '/b', access: 'read', scope: 'exact' },
          { path: '/a', access: 'write', scope: 'subtree' },
        ],
      },
      network: { enabled: true },
    };
    const second: AdditionalPermissionProfile = {
      network: { enabled: true },
      fileSystem: { entries: [...first.fileSystem!.entries].reverse() },
    };
    expect(serializeAdditionalPermissionProfile(first)).toBe(
      serializeAdditionalPermissionProfile(second),
    );
  });
});
