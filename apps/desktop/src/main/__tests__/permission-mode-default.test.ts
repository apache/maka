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
