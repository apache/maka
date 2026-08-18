import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { ComposerSessionMode } from '@maka/ui';
import {
  isLegalSessionModePair,
  SESSION_MODE_FIELDS,
  sessionModeOf,
} from '../../shared/session-mode.js';

const MODES: readonly ComposerSessionMode[] = ['default', 'plan', 'swarm', 'graph'];

describe('session mode fields', () => {
  it('names both fields for every mode, so no write is computed from a read', () => {
    for (const mode of MODES) {
      const fields = SESSION_MODE_FIELDS[mode];
      assert.ok(fields, `${mode} has no fields`);
      assert.equal(sessionModeOf(fields), mode, `${mode} does not read back as itself`);
      assert.ok(isLegalSessionModePair(fields), `${mode} spells an illegal pair`);
    }
  });

  it('reads a record an older build could have written as one of the four', () => {
    assert.equal(sessionModeOf({}), 'default');
    assert.equal(sessionModeOf({ collaborationMode: 'plan', orchestrationMode: 'swarm' }), 'plan');
    assert.equal(sessionModeOf({ orchestrationMode: 'graph' }), 'graph');
  });
});
