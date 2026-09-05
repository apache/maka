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
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  createComputerUseHost,
  computerUseServiceHealth,
} from '../computer-use-host.js';

describe('Computer Use host health', () => {
  const snapshot = (
    state: 'idle' | 'starting' | 'ready' | 'backing_off' | 'unavailable' | 'disposed',
  ) => ({ state, generation: 1, restartAttempts: 0 });

  it('does not report a binary-only executor as healthy before first use', () => {
    assert.deepEqual(computerUseServiceHealth('maka-cu', snapshot('idle')), {
      state: 'not_run',
      reason: 'maka-cu 已可用，将在首次调用时启动。',
    });
  });

  it('reports ready, recovery, and unavailable states', () => {
    assert.equal(computerUseServiceHealth('maka-cu', snapshot('ready')).state, 'healthy');
    assert.equal(
      computerUseServiceHealth('maka-cu', snapshot('backing_off')).reason,
      'maka-cu executor 正在启动或恢复。',
    );
    assert.equal(
      computerUseServiceHealth('maka-cu', snapshot('starting')).state,
      'degraded',
    );
    assert.deepEqual(computerUseServiceHealth('maka-cu', snapshot('unavailable')), {
      state: 'not_available',
      reason: 'maka-cu executor 启动失败或已退出。',
    });
    assert.deepEqual(computerUseServiceHealth('maka-cu', snapshot('disposed')), {
      state: 'not_available',
      reason: 'maka-cu executor 已停止。',
    });
  });

  it('reports a missing backend as unavailable', () => {
    assert.equal(computerUseServiceHealth('none', undefined).state, 'not_available');
  });

  it('constructs a backend only when the local artifact matches the manifest hash', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maka-cu-host-'));
    try {
      const binaryPath = join(directory, 'maka-cu');
      const manifestPath = join(directory, 'bundled-tools.json');
      const bytes = Buffer.from('#!/bin/sh\nexit 0\n');
      await writeFile(binaryPath, bytes);
      await chmod(binaryPath, 0o755);
      const hash = createHash('sha256').update(bytes).digest('hex');
      await writeFile(manifestPath, JSON.stringify({
        makaCu: { binarySha256: hash, distributionReady: false },
      }));

      const validForDevelopment = createComputerUseHost({
        isPackaged: false,
        resourcesPath: directory,
        manifestPath,
        binaryPath,
        physicalInputRecentlyActive: () => false,
      });
      assert.equal(validForDevelopment.selected.backendId, process.platform === 'darwin'
        ? 'maka-cu'
        : 'none');

      const blockedForDistribution = createComputerUseHost({
        isPackaged: true,
        resourcesPath: directory,
        manifestPath,
        binaryPath,
        physicalInputRecentlyActive: () => false,
      });
      assert.equal(blockedForDistribution.selected.backendId, 'none');

      await writeFile(manifestPath, JSON.stringify({
        makaCu: { binarySha256: hash, distributionReady: true },
      }));
      const validForDistribution = createComputerUseHost({
        isPackaged: true,
        resourcesPath: directory,
        manifestPath,
        binaryPath,
        physicalInputRecentlyActive: () => false,
      });
      assert.equal(validForDistribution.selected.backendId, process.platform === 'darwin'
        ? 'maka-cu'
        : 'none');

      await writeFile(manifestPath, JSON.stringify({
        makaCu: {
          binarySha256: '0'.repeat(64),
          distributionReady: true,
        },
      }));
      const invalid = createComputerUseHost({
        isPackaged: false,
        resourcesPath: directory,
        manifestPath,
        binaryPath,
        physicalInputRecentlyActive: () => false,
      });
      assert.equal(invalid.selected.backendId, 'none');

      const linkedBinaryPath = join(directory, 'linked-maka-cu');
      await symlink(binaryPath, linkedBinaryPath);
      const linked = createComputerUseHost({
        isPackaged: false,
        resourcesPath: directory,
        manifestPath,
        binaryPath: linkedBinaryPath,
        physicalInputRecentlyActive: () => false,
      });
      assert.equal(linked.selected.backendId, 'none');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

});
