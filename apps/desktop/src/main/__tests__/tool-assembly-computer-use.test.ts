import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDesktopPhysicalInputGuard } from '../computer-use-host.js';

describe('Desktop Computer Use physical-input guard', () => {
  it('reports input within the last second as recent', () => {
    let idleSeconds = 0.5;
    const physicalInputRecentlyActive = createDesktopPhysicalInputGuard(
      () => idleSeconds,
    );

    assert.equal(physicalInputRecentlyActive(), true);

    idleSeconds = 1;
    assert.equal(physicalInputRecentlyActive(), false);
  });
});
