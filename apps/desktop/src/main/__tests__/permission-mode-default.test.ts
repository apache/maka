/**
 * Behavior tests for the chat-default permission-mode resolver. This is the
 * SINGLE authority for a new session's starting permission mode: the renderer
 * omits `permissionMode` unless the user explicitly picked one in the composer,
 * so main.ts resolves the configured `chatDefaults.permissionMode` here at
 * create time.
 *
 * The two guarantees pinned here (and previously only asserted as a source-grep
 * contract on main.ts):
 *   1. The configured default is returned verbatim (Auto / Bypass).
 *   2. Session creation never fails because settings.json is unreadable — the
 *      store's get() rethrows anything but ENOENT, so a corrupted file must
 *      fall back to the safest mode, not reject the create path.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { AppSettings } from '@maka/core/settings';
import { createDefaultSettings } from '@maka/core/settings';
import { resolveDefaultPermissionMode } from '../permission-mode-default.js';

describe('resolveDefaultPermissionMode', () => {
  it('returns the configured chatDefaults.permissionMode', async () => {
    const settings = createDefaultSettings();
    settings.chatDefaults.permissionMode = 'ask';
    const mode = await resolveDefaultPermissionMode(async () => settings);
    assert.equal(mode, 'ask');
  });

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

  it('defaults to ask via createDefaultSettings when no value is configured', async () => {
    const mode = await resolveDefaultPermissionMode(async () => createDefaultSettings());
    assert.equal(mode, 'ask');
  });
});
