import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagnosticInputForErrorToast } from '../../renderer/app-shell-toast-diagnostics.js';

test('preserves stable Host targets independently from optional execution evidence', () => {
  assert.deepEqual(
    diagnosticInputForErrorToast({
      title: 'Client failure',
    }),
    {
      surface: 'toast',
      title: 'Client failure',
    },
  );
  assert.deepEqual(
    diagnosticInputForErrorToast({
      title: 'Task operation failed',
      diagnosticTarget: { sessionId: '["remote-host","session-1"]' },
    }),
    {
      surface: 'toast',
      title: 'Task operation failed',
      target: { kind: 'session', sessionId: '["remote-host","session-1"]' },
    },
  );
  assert.deepEqual(
    diagnosticInputForErrorToast({
      title: 'New task failed',
      diagnosticTarget: { profileId: 'remote-profile' },
    }),
    {
      surface: 'toast',
      title: 'New task failed',
      target: { kind: 'profile', profileId: 'remote-profile' },
    },
  );
  assert.deepEqual(
    diagnosticInputForErrorToast({
      title: 'Turn failed',
      diagnosticTarget: {
        sessionId: '["remote-host","session-1"]',
        turnId: 'turn-1',
        eventId: 'event-1',
      },
    }),
    {
      surface: 'toast',
      title: 'Turn failed',
      execution: {
        sessionId: '["remote-host","session-1"]',
        turnId: 'turn-1',
        eventId: 'event-1',
      },
    },
  );
});
