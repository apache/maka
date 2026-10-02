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
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { OverlayPaletteActions } from '../../renderer/features/overlays/index.js';
import { createFakeOverlaysServices } from '../../renderer/features/overlays/testing.js';
import { getShellCopy } from '../../renderer/locales/shell-copy.js';
import {
  appShellCommandOptions,
  paletteConnection,
  runPaletteCommand,
} from './app-shell-command-options.js';

// The palette rows resolve the default Runtime Host themselves; the global
// bridge offers nothing else, so a row that still reached Desktop directly
// would fail instead of reaching the injected palette actions.
const defaultHost = { profileId: 'default-profile', hostId: 'default-host' };
const previousWindow = globalThis.window;
const copy = getShellCopy('en').commandActions;

beforeEach(() => {
  globalThis.window = {
    maka: { runtimeHostProfiles: { getDefaultHost: async () => defaultHost } },
  } as unknown as Window & typeof globalThis;
});

afterEach(() => {
  globalThis.window = previousWindow;
});

function recordingPalette(overrides: Partial<OverlayPaletteActions> = {}) {
  const calls: unknown[][] = [];
  const fake = createFakeOverlaysServices().palette;
  const palette: OverlayPaletteActions = {
    testConnection: async (...args) => {
      calls.push(['testConnection', ...args]);
      return (overrides.testConnection ?? fake.testConnection)(...args);
    },
    setDefaultConnection: async (...args) => {
      calls.push(['setDefaultConnection', ...args]);
      return (overrides.setDefaultConnection ?? fake.setDefaultConnection)(...args);
    },
    testNetworkProxy: async (...args) => {
      calls.push(['testNetworkProxy', ...args]);
      return (overrides.testNetworkProxy ?? fake.testNetworkProxy)(...args);
    },
    openLocalMemoryFile: async (...args) => {
      calls.push(['openLocalMemoryFile', ...args]);
      return (overrides.openLocalMemoryFile ?? fake.openLocalMemoryFile)(...args);
    },
    saveConversationToFile: async (...args) => {
      calls.push(['saveConversationToFile', ...args]);
      return (overrides.saveConversationToFile ?? fake.saveConversationToFile)(...args);
    },
  };
  return { palette, calls };
}

describe('command palette Desktop actions', () => {
  test('tests and defaults a connection by slug on the default Host, then refreshes', async () => {
    const { palette, calls } = recordingPalette({
      testConnection: async () => ({ ok: true, latencyMs: 12, modelTested: 'model-1' }),
    });
    const toasts: string[] = [];
    let refreshes = 0;
    const options = appShellCommandOptions(toasts, {
      paletteActions: palette,
      connections: [paletteConnection('work', 'Work')],
      refreshConnections: async () => {
        refreshes += 1;
      },
    });

    await runPaletteCommand(options, 'connection:test:work');
    await runPaletteCommand(options, 'connection:set-default:work');

    assert.deepEqual(calls, [
      ['testConnection', 'work', defaultHost],
      ['setDefaultConnection', 'work', defaultHost],
    ]);
    assert.equal(refreshes, 2);
    assert.deepEqual(toasts, [
      `success:${copy.connectionVerified('Work')}`,
      `success:${copy.setDefaultSuccess('Work')}`,
    ]);
  });

  test('tests the network proxy and opens the memory file on the default Host', async (t) => {
    t.mock.method(console, 'error', () => undefined);
    const { palette, calls } = recordingPalette({
      testNetworkProxy: async () => ({ ok: true, message: 'reachable', latencyMs: 20 }),
      openLocalMemoryFile: async () => ({ ok: false, code: 'missing' }),
    });
    const toasts: string[] = [];
    const options = appShellCommandOptions(toasts, { paletteActions: palette });

    await runPaletteCommand(options, 'diag:test-network-proxy');
    await runPaletteCommand(options, 'diag:open-local-memory');

    assert.deepEqual(calls, [
      ['testNetworkProxy', defaultHost],
      ['openLocalMemoryFile', defaultHost],
    ]);
    assert.equal(toasts[0], `success:${copy.networkPassedTitle}`);
    assert.match(toasts[1] ?? '', new RegExp(`^error:${copy.memoryOpenFailedTitle}:.*:${JSON.stringify({ profileId: 'default-profile' })}$`));
  });

  test('saves the conversation and keeps each outcome\'s toast', async () => {
    const outcomes = [
      { ok: true as const, path: '/tmp/maka.md' },
      { ok: false as const, reason: 'canceled' as const },
      { ok: false as const, reason: 'invalid_input' as const },
    ];
    const { palette, calls } = recordingPalette({
      saveConversationToFile: async () => outcomes.shift()!,
    });
    const toasts: string[] = [];
    const options = appShellCommandOptions(toasts, { paletteActions: palette });

    for (let index = 0; index < 3; index += 1) {
      await runPaletteCommand(options, 'diag:save-conversation-file');
    }

    assert.equal(calls.length, 3);
    const [name, input] = calls[0] ?? [];
    assert.equal(name, 'saveConversationToFile');
    assert.deepEqual(Object.keys(input as object), ['markdown', 'defaultName']);
    assert.match((input as { defaultName: string }).defaultName, /^maka-Long-task-\d{4}-\d{2}-\d{2}\.md$/);
    assert.equal(toasts.length, 2);
    assert.equal(toasts[0], `success:${copy.conversationSavedTitle}`);
    assert.equal(toasts[1], `error:${copy.saveFailedTitle}:${copy.invalidExport}:undefined`);
  });
});
