import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeSessionErrorReason } from '../../renderer/session-error-presentation.js';
import { deriveFailedTurnRecovery, describeTurnErrorClass } from '../../renderer/session-status-presentation.js';

describe('provider capacity presentation', () => {
  it('uses capacity-specific copy instead of the unknown error fallback', () => {
    assert.match(describeSessionErrorReason('provider_capacity') ?? '', /满载/);
    assert.match(describeTurnErrorClass('provider_capacity'), /满载/);
  });

  it('does not recommend an immediate direct retry', () => {
    const recovery = deriveFailedTurnRecovery({
      errorClass: 'provider_capacity',
      partialOutputRetained: false,
      toolActivityCount: 0,
      erroredToolCount: 0,
    });
    assert.equal(recovery.action, 'retry');
    assert.match(recovery.label, /等待几分钟|切换模型/);
    assert.doesNotMatch(recovery.label, /直接重试/);
  });
});
