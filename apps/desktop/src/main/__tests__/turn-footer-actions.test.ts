import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  deriveTurnFooterActions,
  enabledTurnFooterActions,
  type TurnFooterActionId,
  type TurnFooterContext,
} from '../../renderer/turn-footer-actions.js';

function ctx(partial: Partial<TurnFooterContext> = {}): TurnFooterContext {
  return { status: 'completed', hasContent: true, ...partial };
}

function enabledIds(input: TurnFooterContext): TurnFooterActionId[] {
  return enabledTurnFooterActions(input).map((action) => action.id);
}

describe('deriveTurnFooterActions', () => {
  it('keeps the operation order stable', () => {
    assert.deepEqual(
      deriveTurnFooterActions(ctx()).map((action) => action.id),
      ['regenerate', 'branch', 'copy'],
    );
  });

  it('derives enabled operations from status and content', () => {
    assert.deepEqual(enabledIds(ctx({ status: 'running' })), ['copy']);
    for (const status of ['completed', 'failed', 'aborted'] as const) {
      assert.deepEqual(enabledIds(ctx({ status })), ['regenerate', 'branch', 'copy']);
      assert.deepEqual(enabledIds(ctx({ status, hasContent: false })), [
        'regenerate',
        'branch',
      ]);
    }
  });

  it('masks only pending remote operations and leaves local copy available', () => {
    const actions = deriveTurnFooterActions(
      ctx({ pendingActions: new Set(['regenerate', 'copy']) }),
    );
    const regenerate = actions.find((action) => action.id === 'regenerate');
    assert.equal(regenerate?.enabled, false);
    assert.equal(regenerate?.tooltip, '正在处理…');
    assert.equal(actions.find((action) => action.id === 'branch')?.enabled, true);
    assert.equal(actions.find((action) => action.id === 'copy')?.enabled, true);
  });

  it('adds an enabled informational action only when meta is present', () => {
    assert.equal(deriveTurnFooterActions(ctx()).some((action) => action.id === 'info'), false);
    const info = deriveTurnFooterActions(
      ctx({ status: 'running', metaSummary: 'gpt-5.5 · 4.9s' }),
    ).find((action) => action.id === 'info');
    assert.equal(info?.enabled, true);
    assert.equal(info?.tooltip, 'gpt-5.5 · 4.9s');
  });
});
