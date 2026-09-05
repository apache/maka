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
import { slashCommandsForSurface } from '@maka/core/slash-command-catalog';
import { desktopSlashCommandAvailability } from '../../renderer/desktop-slash-command.js';

const offered = (state: { hasSession: boolean; streaming: boolean }): readonly string[] =>
  slashCommandsForSurface('desktop')
    .filter(desktopSlashCommandAvailability(state))
    .map(({ id }) => id);

describe('desktop slash command availability', () => {
  it('withholds /compact while the Turn streams, and nothing else', () => {
    const idle = offered({ hasSession: true, streaming: false });
    assert.ok(idle.includes('compact'), 'an idle Session can compact its context');
    assert.deepEqual(
      offered({ hasSession: true, streaming: true }),
      idle.filter((id) => id !== 'compact'),
    );
  });

  it('offers only the commands that need no Session before one exists', () => {
    // Spelled out rather than derived from the catalog: a new Desktop command
    // reaching an empty composer is a decision, not a default.
    assert.deepEqual(offered({ hasSession: false, streaming: false }), ['graph', 'swarm']);
    assert.deepEqual(offered({ hasSession: false, streaming: true }), ['graph', 'swarm']);
  });
});
