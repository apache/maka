import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_BLOCKED_REASONS,
  SESSION_STATUSES,
  TURN_STATUSES,
  deriveTurnRecords,
  isSessionBlockedReason,
  isSessionStatus,
  isTurnStatus,
} from '../session.js';

describe('SessionStatus contract', () => {
  it('locks the Week 2 lifecycle enum', () => {
    assert.deepEqual(SESSION_STATUSES, [
      'active',
      'running',
      'waiting_for_user',
      'blocked',
      'review',
      'done',
      'archived',
      'aborted',
    ]);
  });

  it('validates status and blocked reason values', () => {
    assert.equal(isSessionStatus('running'), true);
    assert.equal(isSessionStatus('idle'), false);
    assert.deepEqual(SESSION_BLOCKED_REASONS, [
      'NO_REAL_CONNECTION',
      'auth',
      'permission_required',
      'tool_failed',
      'unknown',
    ]);
    assert.equal(isSessionBlockedReason('tool_failed'), true);
    assert.equal(isSessionBlockedReason('raw_provider_error'), false);
  });
});

describe('TurnStatus contract', () => {
  it('locks the Week 2 turn-level status enum', () => {
    assert.deepEqual(TURN_STATUSES, ['running', 'completed', 'aborted', 'failed']);
    assert.equal(isTurnStatus('completed'), true);
    assert.equal(isTurnStatus('active'), false);
  });

  it('derives latest turn state and keeps lineage one-way', () => {
    const turns = deriveTurnRecords([
      { type: 'user', id: 'u1', turnId: 't1', ts: 1, text: 'first' },
      {
        type: 'turn_state',
        id: 's1',
        turnId: 't1',
        ts: 2,
        status: 'running',
        partialOutputRetained: false,
      },
      { type: 'assistant', id: 'a1', turnId: 't1', ts: 3, text: 'partial', modelId: 'm' },
      {
        type: 'turn_state',
        id: 's2',
        turnId: 't1',
        ts: 4,
        status: 'aborted',
        retriedFromTurnId: 't0',
        abortedAt: 4,
        partialOutputRetained: false,
      },
    ]);

    assert.deepEqual(turns, [
      {
        turnId: 't1',
        status: 'aborted',
        statusSource: 'recorded',
        retriedFromTurnId: 't0',
        abortedAt: 4,
        partialOutputRetained: true,
      },
    ]);
  });

  it('migrates legacy turns without turn_state records as completed', () => {
    const turns = deriveTurnRecords([
      { type: 'user', id: 'u1', turnId: 'legacy', ts: 1, text: 'hello' },
      { type: 'assistant', id: 'a1', turnId: 'legacy', ts: 2, text: 'world', modelId: 'm' },
    ]);

    assert.equal(turns[0]?.status, 'completed');
    assert.equal(turns[0]?.partialOutputRetained, true);
  });
});
