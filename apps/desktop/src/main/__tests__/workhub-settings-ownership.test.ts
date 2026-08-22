import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultSettings } from '@maka/core/settings';
import {
  clientOwnedSettingsPatch,
  hasRuntimeHostSettingsPatch,
  projectClientOwnedSettings,
} from '../../shared/settings-ownership.js';

test('keeps the WorkHub opt-in client-global across Runtime Hosts', () => {
  assert.deepEqual(clientOwnedSettingsPatch({ workHub: { enabled: true } }), {
    workHub: { enabled: true },
  });
  assert.equal(hasRuntimeHostSettingsPatch({ workHub: { enabled: true } }), false);

  const client = createDefaultSettings();
  client.workHub.enabled = true;
  const runtimeHost = createDefaultSettings();
  assert.equal(projectClientOwnedSettings(runtimeHost, client).workHub.enabled, true);
});
