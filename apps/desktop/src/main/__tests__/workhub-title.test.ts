import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fallbackWorkHubTitle,
  normalizeGeneratedWorkHubTitle,
} from '../workhub/workhub-title.js';

test('中文 fallback 标题提取工作对象和最终目标，而不是截取整条指令', () => {
  assert.equal(
    fallbackWorkHubTitle('请帮我检查登录超时并修掉，然后运行相关测试，不要修改其他模块。'),
    '修复登录超时',
  );
  assert.equal(
    fallbackWorkHubTitle('把支付回调的幂等校验补齐，然后更新测试'),
    '完善支付回调的幂等校验',
  );
  assert.equal(
    fallbackWorkHubTitle('继续排查刷新令牌过期问题，不要改动登录页面'),
    '排查刷新令牌过期问题',
  );
});

test('模型标题会去掉格式噪音并遵守中英文显示长度', () => {
  assert.equal(
    normalizeGeneratedWorkHubTitle('标题：“修复登录超时与刷新令牌续期”'),
    '修复登录超时与刷新令牌续期',
  );
  const chinese = normalizeGeneratedWorkHubTitle(
    '这是一个明显超过展示预算而且包含很多没有必要实现步骤的中文工作标题',
  );
  assert.ok(chinese);
  assert.ok([...chinese].length <= 24);

  const english = normalizeGeneratedWorkHubTitle(
    'Improve authentication refresh token recovery and add comprehensive regression coverage for every provider',
  );
  assert.ok(english);
  assert.ok([...english].length <= 60);
  assert.equal(english?.endsWith(' '), false);
});
