import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { selectComputerUseBackend } from '@maka/computer-use';
import {
  createDesktopComputerUseHost,
  type createComputerUseHost,
} from '../computer-use-host.js';

describe('Desktop Computer Use tool assembly', () => {
  it('passes a one-second physical-input guard to the Desktop host', () => {
    let idleSeconds = 0.5;
    let hostInput: Parameters<typeof createComputerUseHost>[0] | undefined;

    createDesktopComputerUseHost({
      isPackaged: false,
      resourcesPath: '/resources',
      createHost: (input: Parameters<typeof createComputerUseHost>[0]) => {
        hostInput = input;
        return { selected: selectComputerUseBackend() };
      },
      getSystemIdleTime: () => idleSeconds,
    });

    const physicalInputRecentlyActive = hostInput?.physicalInputRecentlyActive;
    assert.ok(physicalInputRecentlyActive);
    assert.equal(physicalInputRecentlyActive(), true);

    idleSeconds = 1;
    assert.equal(physicalInputRecentlyActive(), false);
  });
});
