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
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { preflightDeclaredSandboxBoundary } from '../sandbox-boundary-declaration.js';
import { SandboxCommandError } from '../sandbox/errors.js';
import type { MakaToolContext } from '../tool-runtime.js';

describe('declared Bash sandbox boundary error classification', () => {
  test('maps a model-correctable boundary semantic error to invalid_boundary_declaration', async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), 'maka-boundary-declaration-'));
    try {
      await assert.rejects(
        preflightDeclaredSandboxBoundary(
          {
            filesystem: {
              entries: [{ path: cwd, access: 'read', scope: 'exact' }],
            },
          },
          toolContext(cwd),
        ),
        (error: unknown) =>
          error instanceof SandboxCommandError &&
          error.reason === 'invalid_boundary_declaration' &&
          /exact sandbox boundary cannot target a directory/.test(error.message),
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test('preserves an injected filesystem failure instead of calling the declaration invalid', async (t) => {
    const injected = Object.assign(new Error('realpath unavailable'), { code: 'EACCES' });
    t.mock.method(fs, 'realpath', async () => {
      throw injected;
    });

    await assert.rejects(
      preflightDeclaredSandboxBoundary(
        {
          filesystem: {
            entries: [{ path: '/workspace/file.txt', access: 'read', scope: 'exact' }],
          },
        },
        toolContext('/workspace'),
      ),
      (error: unknown) => error === injected && !(error instanceof SandboxCommandError),
    );
  });
});

function toolContext(cwd: string): MakaToolContext {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: 'tool-1',
    cwd,
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}
