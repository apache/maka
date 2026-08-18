import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { CollaborationMode } from '@maka/core/collaboration';
import type { OrchestrationMode } from '@maka/core/orchestration';
import type { ComposerSessionMode } from '@maka/ui';
import {
  isLegalSessionModePair,
  SESSION_MODE_FIELDS,
  sessionModeOf,
  sessionModeWriteOrder,
  type SessionModeFields,
} from '../../renderer/session-mode.js';

const MODES: readonly ComposerSessionMode[] = ['default', 'plan', 'swarm', 'graph'];
const COLLABORATION: readonly CollaborationMode[] = ['agent', 'plan'];
const ORCHESTRATION: readonly OrchestrationMode[] = ['default', 'swarm', 'graph'];

/** Every pair a Session could already hold, legal or not. */
function everyStartingPair(): SessionModeFields[] {
  return COLLABORATION.flatMap((collaborationMode) =>
    ORCHESTRATION.map((orchestrationMode) => ({ collaborationMode, orchestrationMode })),
  );
}

describe('session mode fields', () => {
  it('names both fields for every mode, so no write is computed from a read', () => {
    for (const mode of MODES) {
      const fields = SESSION_MODE_FIELDS[mode];
      assert.ok(fields, `${mode} has no fields`);
      assert.equal(sessionModeOf(fields), mode, `${mode} does not read back as itself`);
      assert.ok(isLegalSessionModePair(fields), `${mode} spells an illegal pair`);
    }
  });

  it('never passes through an illegal pair, from any starting state', () => {
    for (const start of everyStartingPair()) {
      for (const mode of MODES) {
        const target = SESSION_MODE_FIELDS[mode];
        let state = start;
        for (const field of sessionModeWriteOrder(mode)) {
          state = field === 'collaboration'
            ? { ...state, collaborationMode: target.collaborationMode }
            : { ...state, orchestrationMode: target.orchestrationMode };
          // The state between the two writes is what a partial failure leaves
          // behind. Reversing the order breaks exactly this assertion.
          assert.ok(
            isLegalSessionModePair(state),
            `${JSON.stringify(start)} → ${mode} passes through ${JSON.stringify(state)}`,
          );
        }
        assert.deepEqual(state, target);
      }
    }
  });

  it('reads a record an older build could have written as one of the four', () => {
    assert.equal(sessionModeOf({}), 'default');
    assert.equal(sessionModeOf({ collaborationMode: 'plan', orchestrationMode: 'swarm' }), 'plan');
    assert.equal(sessionModeOf({ orchestrationMode: 'graph' }), 'graph');
  });
});
