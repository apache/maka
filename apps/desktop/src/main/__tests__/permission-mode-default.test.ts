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

/**
 * Behavior tests for the chat-default permission-mode resolver. This is the
 * SINGLE authority for a new session's starting permission mode: the renderer
 * omits `permissionMode` unless the user explicitly picked one in the composer,
 * so main.ts resolves the configured `chatDefaults.permissionMode` here at
 * create time.
 *
 * The guarantees pinned here are the non-default configured mode and failure
 * behavior. Session creation never fails because settings.json is unreadable:
 * a corrupted file falls back to the safest mode instead of rejecting create.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { AppSettings } from '@maka/core/settings';
import { createDefaultSettings } from '@maka/core/settings';
import { resolveDefaultPermissionMode } from '../permission-mode-default.js';

describe('resolveDefaultPermissionMode', () => {
  it('returns bypass when that is the configured default (no special-casing)', async () => {
    const settings = createDefaultSettings();
    settings.chatDefaults.permissionMode = 'bypass';
    const mode = await resolveDefaultPermissionMode(async () => settings);
    assert.equal(mode, 'bypass');
  });

  it('falls back to ask when the settings read rejects (corrupted settings.json)', async () => {
    const readFailingSettings = async (): Promise<AppSettings> => {
      throw new Error("simulated settingsStore.get() rethrow (non-ENOENT)");
    };
    const mode = await resolveDefaultPermissionMode(readFailingSettings);
    assert.equal(mode, 'ask');
  });
});
