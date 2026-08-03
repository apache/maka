import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { hasInterruptibleUpdateWork } from '../app-update-activity.js';

describe('App update activity', () => {
  test('guards every kind of work that app shutdown interrupts', () => {
    const cases = [
      { name: 'idle', session: false, automation: false, shells: 0, expected: false },
      { name: 'session turn', session: true, automation: false, shells: 0, expected: true },
      { name: 'Automation fire', session: false, automation: true, shells: 0, expected: true },
      { name: 'background shell', session: false, automation: false, shells: 1, expected: true },
    ];

    for (const input of cases) {
      assert.equal(
        hasInterruptibleUpdateWork({
          sessionActivities: { hasActive: () => input.session },
          automationScheduler: { hasInFlight: () => input.automation },
          shellRuns: { liveCount: () => input.shells },
        }),
        input.expected,
        input.name,
      );
    }
  });
});
