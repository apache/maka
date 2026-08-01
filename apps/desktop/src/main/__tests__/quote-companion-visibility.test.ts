import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  applyCompanionForkVisibilityEvent,
  reconcileCompanionForkVisibility,
} from '../../renderer/quote-companion-visibility.js';

describe('quote companion visibility ownership', () => {
  it('retains every created fork until its own cleanup succeeds', () => {
    let hidden: ReadonlySet<string> = new Set();
    hidden = applyCompanionForkVisibilityEvent(hidden, {
      type: 'fork-created',
      sessionId: 'fork-a',
    });
    hidden = applyCompanionForkVisibilityEvent(hidden, {
      type: 'fork-created',
      sessionId: 'fork-b',
    });

    hidden = applyCompanionForkVisibilityEvent(hidden, {
      type: 'cleanup-succeeded',
      sessionId: 'fork-b',
    });

    assert.deepEqual([...hidden], ['fork-a']);
  });

  it('releases ids absent from an authoritative session list', () => {
    const hidden = reconcileCompanionForkVisibility(
      new Set(['fork-pending', 'fork-removed']),
      new Set(['fork-pending', 'main-session']),
    );

    assert.deepEqual([...hidden], ['fork-pending']);
  });
});
