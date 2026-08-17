import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SessionEvent } from '@maka/core/events';

import { sessionEventErrorMessage } from '../../renderer/model-connection-errors.js';
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

  test('does not present a provider permission code as a local permission wait', () => {
    assert.equal(describeTurnErrorClass('permission_required'), '等待权限确认');
    assert.equal(describeTurnErrorClass('permission_error'), '未知错误');
  });

  test('preserves the bounded provider summary for a neutral Kimi plan-limit event', () => {
    const message =
      "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle. " +
      'To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/code/#pricing ' +
      '(code=permission_error, status=403)';
    const event: Extract<SessionEvent, { type: 'error' }> = {
      type: 'error',
      id: 'event-kimi-plan-limit',
      turnId: 'turn-kimi-plan-limit',
      ts: 1,
      recoverable: false,
      code: 'permission_error',
      boundedProviderMessage: true,
      message,
    };

    assert.equal(sessionEventErrorMessage(event), message);
    assert.equal(sessionEventErrorMessage(event, 'en'), message);
  });

  test('does not render a coded message verbatim without the bounded-provider marker', () => {
    const event: Extract<SessionEvent, { type: 'error' }> = {
      type: 'error',
      id: 'event-ecodes',
      turnId: 'turn-ecodes',
      ts: 1,
      recoverable: false,
      code: 'ECONNRESET',
      message: 'socket hang up at internal-connect.ts:42 (raw internal text)',
    };

    assert.equal(sessionEventErrorMessage(event), '任务运行失败，请稍后重试。');
    assert.equal(sessionEventErrorMessage(event, 'en'), 'The task run failed. Try again later.');
  });

  test('uses generic copy when an error has neither a known reason nor provider evidence', () => {
    const event: Extract<SessionEvent, { type: 'error' }> = {
      type: 'error',
      id: 'event-unknown',
      turnId: 'turn-unknown',
      ts: 1,
      recoverable: false,
      message: '403 permission denied',
    };

    assert.equal(sessionEventErrorMessage(event), '任务运行失败，请稍后重试。');
    assert.equal(sessionEventErrorMessage(event, 'en'), 'The task run failed. Try again later.');
  });
});
