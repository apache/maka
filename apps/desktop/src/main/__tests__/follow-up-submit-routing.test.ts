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
import { describe, it } from 'node:test';
import {
  hasActiveTurnAtSubmit,
  mergeWorkspaceReferences,
  resolveFollowUpModeAtSubmit,
} from '../../renderer/follow-up-submit-routing.js';

describe('follow-up submit routing', () => {
  it('uses the synchronous turn arm before React publishes streaming state', () => {
    assert.equal(
      hasActiveTurnAtSubmit({
        liveTurn: { turnId: 'turn-1' },
        runningTurnIds: [],
      }),
      true,
    );
  });

  it('ignores a terminal projection whose only running id is the same turn', () => {
    assert.equal(
      hasActiveTurnAtSubmit({
        liveTurn: { turnId: 'turn-1', terminal: true },
        runningTurnIds: ['turn-1'],
      }),
      false,
    );
  });

  it('routes burst input through the selected follow-up lane', () => {
    assert.equal(
      resolveFollowUpModeAtSubmit({
        hasActiveTurn: true,
        slashCommand: null,
      }),
      'queue',
    );
    assert.equal(
      resolveFollowUpModeAtSubmit({
        requestedMode: 'steer',
        hasActiveTurn: true,
        slashCommand: null,
      }),
      'steer',
    );
  });

  it('starts a normal turn only when no active-turn witness exists', () => {
    assert.equal(
      resolveFollowUpModeAtSubmit({
        hasActiveTurn: false,
        slashCommand: null,
      }),
      undefined,
    );
  });

  it('dispatches a slash command mid-turn instead of steering it into the Turn', () => {
    assert.equal(
      resolveFollowUpModeAtSubmit({
        hasActiveTurn: true,
        slashCommand: { kind: 'side' },
      }),
      undefined,
    );
    // An explicit steer request loses to the command too: Shift+Enter on
    // `/side` still opens the side chat.
    assert.equal(
      resolveFollowUpModeAtSubmit({
        requestedMode: 'steer',
        hasActiveTurn: true,
        slashCommand: { kind: 'side' },
      }),
      undefined,
    );
  });

  it('restores workspace references after queued text returns to the draft', () => {
    assert.deepEqual(
      mergeWorkspaceReferences(
        'preface\n\nreview @src/app.ts',
        undefined,
        [{
          kind: 'workspace_file',
          value: '@src/app.ts',
          label: 'src/app.ts',
          start: 7,
        }],
      ),
      [{ value: '@src/app.ts', start: 16 }],
    );
  });
});
