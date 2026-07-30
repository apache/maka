/**
 * Locator boundary contract.
 *
 * The locator is the one place the card trusts output from a separate
 * process. Every failure mode has to land on `null` at the caller, because
 * the fallback (cursor anchoring) is a working state and a thrown error
 * here would take down an onboarding flow over a missing 89KB binary.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  locateSettingsWindow,
  type LocateDeps,
} from '../permission-overlay/settings-window-locator.js';

function deps(overrides: Partial<LocateDeps> = {}): LocateDeps {
  return {
    binaryPath: '/fake/settings-window-locator',
    platform: 'darwin',
    timeoutMs: 150,
    exists: () => true,
    runBinary: async () => ({ stdout: '{"ok":true,"x":10,"y":20,"width":700,"height":800}' }),
    ...overrides,
  };
}

describe('settings window locator', () => {
  it('parses a located window', async () => {
    const result = await locateSettingsWindow(deps());
    assert.deepEqual(result, { ok: true, frame: { x: 10, y: 20, width: 700, height: 800 } });
  });

  it('passes through the reasons the binary actually emits', async () => {
    for (const reason of ['not_running', 'no_settings_window', 'window_list_failed']) {
      const result = await locateSettingsWindow(
        deps({ runBinary: async () => ({ stdout: `{"ok":false,"reason":"${reason}"}` }) }),
      );
      assert.deepEqual(result, { ok: false, reason });
    }
  });

  it('does not trust an unknown reason string', async () => {
    // A reason we do not emit means the thing on the other end is not the
    // binary we think it is; treat it as malformed rather than forwarding.
    const result = await locateSettingsWindow(
      deps({ runBinary: async () => ({ stdout: '{"ok":false,"reason":"../../etc/passwd"}' }) }),
    );
    assert.deepEqual(result, { ok: false, reason: 'bad_output' });
  });

  it('rejects malformed, non-numeric, and zero-area output', async () => {
    const bad = [
      'not json at all',
      '',
      'null',
      '[]',
      '{"ok":true}',
      '{"ok":true,"x":"10","y":20,"width":700,"height":800}',
      '{"ok":true,"x":10,"y":20,"width":0,"height":800}',
      '{"ok":true,"x":10,"y":20,"width":700,"height":-5}',
      '{"ok":true,"x":null,"y":20,"width":700,"height":800}',
    ];
    for (const stdout of bad) {
      const result = await locateSettingsWindow(deps({ runBinary: async () => ({ stdout }) }));
      assert.equal(result.ok, false, `${JSON.stringify(stdout)} must not parse as a frame`);
      assert.equal(result.ok === false && result.reason, 'bad_output', JSON.stringify(stdout));
    }
  });

  it('reports a NaN/Infinity frame as malformed rather than moving a window to it', async () => {
    const result = await locateSettingsWindow(
      deps({ runBinary: async () => ({ stdout: '{"ok":true,"x":1e999,"y":20,"width":700,"height":800}' }) }),
    );
    assert.deepEqual(result, { ok: false, reason: 'bad_output' });
  });

  it('degrades when the binary is missing or the spawn fails', async () => {
    assert.deepEqual(
      await locateSettingsWindow(deps({ exists: () => false })),
      { ok: false, reason: 'binary_missing' },
    );
    assert.deepEqual(
      await locateSettingsWindow(deps({ runBinary: async () => null })),
      { ok: false, reason: 'spawn_failed' },
    );
  });

  it('never runs the binary off darwin', async () => {
    let ran = false;
    const result = await locateSettingsWindow(
      deps({ platform: 'linux', runBinary: async () => { ran = true; return null; } }),
    );
    assert.deepEqual(result, { ok: false, reason: 'unsupported_platform' });
    assert.equal(ran, false, 'the platform gate must come before the spawn');
  });
});
