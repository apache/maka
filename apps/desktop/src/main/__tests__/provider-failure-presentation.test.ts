import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { describeSessionErrorReason } from '../../renderer/session-error-presentation.js';
import {
  deriveFailedTurnRecovery,
  describeTurnErrorClass,
} from '../../renderer/session-status-presentation.js';

describe('provider failure presentation', () => {
  test('keeps provider account and access failures distinct in both locales', () => {
    assert.equal(describeSessionErrorReason('usage_limit'), '模型使用额度已用完');
    assert.equal(describeSessionErrorReason('provider_permission'), '模型服务拒绝访问');
    assert.equal(describeSessionErrorReason('usage_limit', 'en'), 'Model usage limit reached');
    assert.equal(describeSessionErrorReason('provider_permission', 'en'), 'Provider access denied');
  });

  test('does not present a bare 403 as an authentication failure', () => {
    assert.equal(describeTurnErrorClass('403'), '未知错误');
    assert.deepEqual(
      deriveFailedTurnRecovery({
        errorClass: 'usage_limit',
        partialOutputRetained: false,
        toolActivityCount: 0,
        erroredToolCount: 0,
      }),
      {
        action: 'check_account',
        label: '检查模型服务的额度、套餐或恢复时间',
      },
    );
  });
});
