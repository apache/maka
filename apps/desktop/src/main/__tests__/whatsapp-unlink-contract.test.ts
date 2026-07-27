import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = await readFile(
  new URL('../../../src/main/settings-ipc-main.ts', import.meta.url),
  'utf8',
);

test('WhatsApp unlink removes only the local active auth directory after runtime shutdown', () => {
  const updateStart = source.indexOf("ipcMain.handle('settings:update'");
  const updateEnd = source.indexOf("ipcMain.handle('settings:testNetworkProxy'", updateStart);
  assert.ok(updateStart >= 0 && updateEnd > updateStart, 'settings:update handler must exist');
  const updateHandler = source.slice(updateStart, updateEnd);

  const runtimeEffects = updateHandler.indexOf('await applySettingsRuntimeEffects(next, patch)');
  const unlinkGuard = updateHandler.indexOf(
    'normalizedPatch.botChat?.channels?.whatsapp?.sessionConfigured === false',
  );
  const authRemoval = updateHandler.indexOf(
    "await rm(join(deps.botDataDir, 'whatsapp', 'default')",
  );

  assert.ok(runtimeEffects >= 0, 'settings:update must apply runtime effects');
  assert.ok(unlinkGuard > runtimeEffects, 'unlink cleanup must run only after the bridge is stopped');
  assert.ok(authRemoval > unlinkGuard, 'unlink must remove the WhatsApp active auth directory');
  assert.match(
    updateHandler,
    /recursive:\s*true,\s*force:\s*true/,
    'auth directory removal must be idempotent and recursive',
  );
});
