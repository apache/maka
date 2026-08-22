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
import { parseMakaRunArgs } from '../run-command-core.js';

describe('maka run argument parsing', () => {
  test('recognizes stdin prompt mode and rejects malformed limits', () => {
    assert.deepEqual(parseMakaRunArgs(['-']), {
      kind: 'run',
      options: { stdinPrompt: true },
    });
    assert.equal(parseMakaRunArgs(['x', '--timeout', '0']).kind, 'error');
    assert.equal(parseMakaRunArgs(['x', '--max-steps', '1.5']).kind, 'error');
  });

  test('accepts only the explicit non-interactive sandbox bypass flag', () => {
    assert.deepEqual(parseMakaRunArgs(['run tools', '--yolo']), {
      kind: 'run',
      options: {
        prompt: 'run tools',
        stdinPrompt: false,
        yolo: true,
      },
    });
  });

  test('parses resume and continue session selectors and rejects combining them', () => {
    assert.deepEqual(parseMakaRunArgs(['next', '--resume', 'session-1']), {
      kind: 'run',
      options: { prompt: 'next', stdinPrompt: false, resumeId: 'session-1' },
    });
    assert.deepEqual(parseMakaRunArgs(['next', '--continue']), {
      kind: 'run',
      options: { prompt: 'next', stdinPrompt: false, continueLatest: true },
    });
    assert.equal(parseMakaRunArgs(['next', '--resume', 'session-1', '--continue']).kind, 'error');
  });

  test('accepts a remote Host Project and rejects client cwd semantics', () => {
    assert.deepEqual(parseMakaRunArgs(['next', '--host', 'office', '--project', 'project-1']), {
      kind: 'run',
      options: {
        prompt: 'next',
        stdinPrompt: false,
        hostProfileId: 'office',
        projectId: 'project-1',
      },
    });
    assert.equal(parseMakaRunArgs(['next', '--host', 'office', '--continue']).kind, 'error');
    assert.equal(
      parseMakaRunArgs(['next', '--host', 'office', '--cwd', '/client/path']).kind,
      'error',
    );
  });
});
