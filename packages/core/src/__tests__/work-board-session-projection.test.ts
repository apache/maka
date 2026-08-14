import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { projectWorkBoardLinkedSession } from '../work-board-session-projection.js';

describe('Work Board linked-session projection', () => {
  test('projects the session status without inventing a verdict', () => {
    const projection = projectWorkBoardLinkedSession({
      sessionId: 'session-1',
      sessionStatus: 'waiting_for_user',
      currentTurn: {
        turnId: 'turn-1',
        runId: 'run-1',
        status: 'running',
      },
    });
    assert.deepEqual(projection, {
      sessionId: 'session-1',
      sessionStatus: 'waiting_for_user',
      currentTurn: {
        turnId: 'turn-1',
        runId: 'run-1',
        status: 'running',
      },
    });
  });

  test('projects a missing Session without a current turn', () => {
    const projection = projectWorkBoardLinkedSession({
      sessionId: 'session-missing',
      sessionStatus: 'missing',
    });
    assert.deepEqual(projection, {
      sessionId: 'session-missing',
      sessionStatus: 'missing',
    });
  });

  test('rejects a missing Session that claims a current turn', () => {
    assert.equal(
      projectWorkBoardLinkedSession({
        sessionId: 'session-missing',
        sessionStatus: 'missing',
        currentTurn: { turnId: 'turn-1', runId: 'run-1', status: 'running' },
      }),
      null,
    );
  });

  test('rejects unknown statuses and malformed refs', () => {
    assert.equal(projectWorkBoardLinkedSession({ sessionId: 's1', sessionStatus: 'flying' }), null);
    assert.equal(
      projectWorkBoardLinkedSession({
        sessionId: 's1',
        sessionStatus: 'running',
        currentTurn: { turnId: '', runId: 'run-1', status: 'running' },
      }),
      null,
    );
  });
});
