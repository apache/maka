import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { LlmConnection } from '@maka/core';
import { connectionChipStatus } from '../../renderer/settings/provider-connection-status.js';
import { connectionLastTestMessageDisplay } from '../../renderer/settings/provider-panel-shared.js';

function conn(input: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'c1',
    name: '连接 1',
    providerType: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...input,
  };
}

describe('connectionChipStatus', () => {
  it('maps lifecycle states without stale readiness signals', () => {
    const cases: Array<
      [Partial<LlmConnection>, ReturnType<typeof connectionChipStatus>]
    > = [
      [
        { enabled: false, lastTestStatus: 'needs_reauth' },
        { label: '需要重新登录', tone: 'attention' },
      ],
      [
        { enabled: true, lastTestStatus: 'needs_reauth' },
        { label: '需要重新登录', tone: 'attention' },
      ],
      [
        { enabled: false, lastTestStatus: 'error' },
        { label: '暂不可用 · 上次连接失败', tone: 'error' },
      ],
      [{ enabled: false, lastTestStatus: undefined }, { label: '暂不可用', tone: 'neutral' }],
      [{ enabled: false, lastTestStatus: 'verified' }, { label: '暂不可用', tone: 'neutral' }],
      [{ enabled: true, lastTestStatus: 'verified' }, null],
      [
        { enabled: true, lastTestStatus: 'error' },
        { label: '上次连接失败', tone: 'error' },
      ],
      [{ enabled: true, lastTestStatus: undefined }, null],
    ];
    for (const [input, expected] of cases) {
      assert.deepEqual(connectionChipStatus(conn(input)), expected);
    }
  });
});

describe('connectionLastTestMessageDisplay', () => {
  it('localizes legacy status text without exposing unknown raw provider messages', () => {
    assert.equal(connectionLastTestMessageDisplay('Authentication failed'), '鉴权失败');
    assert.equal(connectionLastTestMessageDisplay('GitHub Copilot 登录已导入。'), 'GitHub Copilot 登录已导入。');
    assert.equal(connectionLastTestMessageDisplay('upstream detail that should not reach settings'), '连接测试状态暂时无法显示，请重新测试。');
    assert.equal(connectionLastTestMessageDisplay(undefined), undefined);
  });
});
