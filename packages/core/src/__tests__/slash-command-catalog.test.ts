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
import { slashCommandsForSurface } from '../slash-command-catalog.js';

describe('slash command catalog', () => {
  test('/todo is a TUI-only read of the current session Todo projection', () => {
    const todo = slashCommandsForSurface('tui').find((command) => command.id === 'todo');

    assert.deepEqual(todo, {
      id: 'todo',
      session: 'required',
      surfaces: ['tui'],
    });
    assert.equal(
      slashCommandsForSurface('desktop').some((command) => (command.id as string) === 'todo'),
      false,
    );
  });
});
