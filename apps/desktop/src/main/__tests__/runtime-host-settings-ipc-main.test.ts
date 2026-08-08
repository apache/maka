import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import { createSettingsStore } from '@maka/storage';
import {
  updateRuntimeHostSettings,
  type RuntimeHostSettingsIpcDeps,
} from '../runtime-host-settings-ipc-main.js';

test('persists a project-only patch in the client-owned settings document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-runtime-host-settings-'));
  try {
    const settingsStore = createSettingsStore(root);
    const client = {
      queryRuntimePolicy: async () => ({ revision: 0, policy: createDefaultRuntimePolicy() }),
      queryCredential: async () => null,
      deleteCredential: async () => { throw new Error('not used'); },
      setCredential: async () => { throw new Error('not used'); },
      testNetworkProxy: async () => { throw new Error('not used'); },
      updateRuntimePolicy: async () => { throw new Error('not used'); },
    } satisfies RuntimeHostSettingsIpcDeps['client'];
    let appliedProjectId: string | undefined;

    const result = await updateRuntimeHostSettings(
      {
        ipcMain: { handle() {} },
        client,
        settingsStore,
        applyClientSettings: async (settings) => {
          appliedProjectId = settings.projects.defaultProjectId;
        },
      },
      { projects: { defaultProjectId: 'project-1' } },
    );

    assert.equal(result.projects.defaultProjectId, 'project-1');
    assert.equal((await settingsStore.get()).projects.defaultProjectId, 'project-1');
    assert.equal(appliedProjectId, 'project-1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
