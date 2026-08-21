import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveManualDiagnosticTarget } from '../../renderer/app-shell-command-actions.js';

test('targets manual diagnostics to the current task or new-task Host profile', () => {
  assert.deepEqual(
    resolveManualDiagnosticTarget(
      { navSection: 'sessions', sessionId: '["remote-host","session-1"]' },
      'new-task-profile',
    ),
    { kind: 'session', sessionId: '["remote-host","session-1"]' },
  );
  assert.deepEqual(
    resolveManualDiagnosticTarget(
      { navSection: 'sessions', sessionId: undefined },
      'new-task-profile',
    ),
    { kind: 'profile', profileId: 'new-task-profile' },
  );
  assert.equal(
    resolveManualDiagnosticTarget(
      { navSection: 'extensions', sessionId: undefined },
      'new-task-profile',
    ),
    undefined,
  );
  assert.deepEqual(
    resolveManualDiagnosticTarget(
      { navSection: 'sessions', sessionId: '["hidden-host","hidden-session"]' },
      'hidden-new-task-profile',
      true,
      'settings-profile',
    ),
    { kind: 'profile', profileId: 'settings-profile' },
  );
  assert.equal(
    resolveManualDiagnosticTarget(
      { navSection: 'sessions', sessionId: '["hidden-host","hidden-session"]' },
      'hidden-new-task-profile',
      true,
    ),
    undefined,
  );
});
