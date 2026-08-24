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

import { strict as assert } from 'node:assert';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  resolveProjectContextRoot,
  SESSION_WORKSPACE_UNAVAILABLE_CODE,
} from '../project-context-root.js';

describe('resolveProjectContextRoot', () => {
  it('uses the app project root when there is no active session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-new-task-project-'));
    try {
      const resolved = await resolveProjectContextRoot(undefined, {
        currentProjectRoot: async () => root,
        readSessionCwd: async () => {
          throw new Error('must not read a session');
        },
      });
      assert.equal(resolved, root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the persisted session cwd instead of the app project root', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'maka-app-project-'));
    const sessionRoot = await mkdtemp(join(tmpdir(), 'maka-session-project-'));
    let appRootReads = 0;
    try {
      const resolved = await resolveProjectContextRoot('session-a', {
        currentProjectRoot: async () => {
          appRootReads += 1;
          return appRoot;
        },
        readSessionCwd: async (sessionId) => {
          assert.equal(sessionId, 'session-a');
          return sessionRoot;
        },
      });
      assert.equal(resolved, sessionRoot);
      assert.equal(appRootReads, 0);
    } finally {
      await rm(appRoot, { recursive: true, force: true });
      await rm(sessionRoot, { recursive: true, force: true });
    }
  });

  it('rejects a deleted session cwd without falling back to the app project', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'maka-fallback-project-'));
    const deletedRoot = await mkdtemp(join(tmpdir(), 'maka-deleted-session-project-'));
    await rm(deletedRoot, { recursive: true, force: true });
    let appRootReads = 0;
    try {
      await assert.rejects(
        () => resolveProjectContextRoot('session-a', {
          currentProjectRoot: async () => {
            appRootReads += 1;
            return appRoot;
          },
          readSessionCwd: async () => deletedRoot,
        }),
        (error) => {
          assert.equal((error as NodeJS.ErrnoException).code, SESSION_WORKSPACE_UNAVAILABLE_CODE);
          return true;
        },
      );
      assert.equal(appRootReads, 0);
    } finally {
      await rm(appRoot, { recursive: true, force: true });
    }
  });

  it('rejects a session cwd without read and traversal access', {
    skip:
      process.platform === 'win32'
        ? 'POSIX permissions are required to make the session cwd inaccessible'
        : process.getuid?.() === 0,
  }, async () => {
    const sessionRoot = await mkdtemp(join(tmpdir(), 'maka-inaccessible-session-project-'));
    await chmod(sessionRoot, 0o000);
    try {
      await assert.rejects(
        () => resolveProjectContextRoot('session-a', {
          currentProjectRoot: async () => {
            throw new Error('must not fall back to the app project');
          },
          readSessionCwd: async () => sessionRoot,
        }),
        (error) => {
          assert.equal((error as NodeJS.ErrnoException).code, SESSION_WORKSPACE_UNAVAILABLE_CODE);
          return true;
        },
      );
    } finally {
      await chmod(sessionRoot, 0o700);
      await rm(sessionRoot, { recursive: true, force: true });
    }
  });
});
