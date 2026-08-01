import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  SANDBOX_BOUNDARY_RESTART_CLOSURE_CLASS,
  SESSION_BLOCKED_REASONS,
  SESSION_STATUSES,
} from '@maka/core';
import {
  deriveFailedTurnRecovery,
  describeBlockedReason,
  describeTurnErrorClass,
  presentSessionStatus,
  sessionStatusAriaLabel,
} from '../../renderer/session-status-presentation.js';

describe('session status presentation', () => {
  it('covers the status vocabulary with localized semantic presentations', () => {
    const tones = new Set([
      'accent',
      'warning',
      'destructive',
      'info',
      'success',
      'muted',
      'neutral',
    ]);
    for (const status of SESSION_STATUSES) {
      const presentation = presentSessionStatus(status);
      assert.match(presentation.label, /[一-鿿]/, status);
      assert.equal(tones.has(presentation.tone), true, status);
    }

    assert.equal(presentSessionStatus('archived').interactive, false);
    assert.equal(presentSessionStatus('aborted').interactive, false);
    assert.equal(presentSessionStatus('running').interactive, true);
    assert.equal(presentSessionStatus('blocked').tone, 'warning');
    assert.equal(presentSessionStatus('done').tone, 'success');
  });

  it('localizes blocked reasons and composes safe accessible labels', () => {
    for (const reason of SESSION_BLOCKED_REASONS) {
      const copy = describeBlockedReason(reason);
      assert.match(copy, /[一-鿿]/, reason);
      assert.equal(copy.includes(reason), false, reason);
    }

    assert.equal(describeBlockedReason(undefined), describeBlockedReason('unknown'));
    assert.equal(describeBlockedReason('NO_REAL_CONNECTION'), '等待配置可用模型连接');
    assert.match(describeBlockedReason('auth'), /登录|登陆/);
    assert.equal(sessionStatusAriaLabel('running'), presentSessionStatus('running').label);
    assert.match(sessionStatusAriaLabel('blocked', 'auth'), /需要处理 · .*登录|需要处理 · .*登陆/);
    assert.match(sessionStatusAriaLabel('blocked'), /运行中断，可重试/);
  });
});

describe('failed turn presentation', () => {
  it('classifies representative runtime errors without exposing raw identifiers', () => {
    const cases: Array<[string | undefined, RegExp]> = [
      ['timeout', /超时/],
      ['AUTH_FAILED', /鉴权/],
      ['rate_limit', /速率/],
      ['fetch_failed', /网络/],
      ['503', /模型服务返回错误/],
      ['context_overflow', /上下文/],
      ['provider_billing', /计费/],
      ['tool_failed', /工具/],
      ['tool_step_cap_reached', /工具步骤上限/],
      ['app_restarted', /应用重启/],
      [SANDBOX_BOUNDARY_RESTART_CLOSURE_CLASS, /等待确认.*请求已按拒绝关闭/],
      [undefined, /未知错误/],
      ['something_new', /未知错误/],
    ];

    for (const [errorClass, pattern] of cases) {
      const copy = describeTurnErrorClass(errorClass);
      assert.match(copy, pattern, String(errorClass));
      if (errorClass) assert.equal(copy.includes(errorClass), false, errorClass);
    }
  });

  it('chooses recovery from side-effect and resumability evidence', () => {
    const cases = [
      { input: ['app_restarted', false, 0, 0] as const, action: 'continue' },
      { input: [SANDBOX_BOUNDARY_RESTART_CLOSURE_CLASS, false, 0, 0] as const, action: 'retry' },
      { input: ['tool_failed', false, 1, 1] as const, action: 'inspect_tool' },
      { input: ['tool_step_cap_reached', true, 1, 0] as const, action: 'continue' },
      { input: ['auth', false, 0, 0] as const, action: 'check_connection' },
      { input: ['provider_billing', false, 0, 0] as const, action: 'check_connection' },
      { input: ['timeout', true, 0, 0] as const, action: 'continue' },
      { input: ['timeout', false, 1, 0] as const, action: 'inspect_tool' },
      { input: ['timeout', false, 0, 0] as const, action: 'retry' },
    ];

    for (const { input, action } of cases) {
      const [errorClass, partialOutputRetained, toolActivityCount, erroredToolCount] = input;
      const recovery = deriveFailedTurnRecovery({
        errorClass,
        partialOutputRetained,
        toolActivityCount,
        erroredToolCount,
      });
      assert.equal(recovery.action, action, errorClass);
      assert.match(recovery.label, /[一-鿿]/, errorClass);
      assert.equal(recovery.label.includes(errorClass), false, errorClass);
    }
  });
});
