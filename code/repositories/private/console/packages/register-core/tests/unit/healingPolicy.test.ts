import { describe, it, expect } from 'vitest';
import { HealingPolicy } from '../../src/flows/HealingPolicy.js';

describe('HealingPolicy', () => {
    const policy = new HealingPolicy();
    const ctx = (attempt: number) => ({ attempt, maxAttempts: 3, phase: 'phase1' });

    it('手机号已注册 → 换号', () => {
        expect(policy.decide(new Error('PhoneAlreadyRegistered'), ctx(1)).action).toBe('changeNumber');
    });
    it('账号停用 → 放弃', () => {
        expect(policy.decide(new Error('AccountDeactivated'), ctx(1)).action).toBe('giveUp');
    });
    it('Google SSO → 放弃', () => {
        expect(policy.decide(new Error('accounts.google.com redirect'), ctx(1)).action).toBe('giveUp');
    });
    it('邮箱验证码超时 → 换邮箱', () => {
        expect(policy.decide(new Error('EmailCodeTimeout'), ctx(1)).action).toBe('changeEmail');
    });
    it('代理连接失败 → 换代理', () => {
        expect(policy.decide(new Error('ERR_PROXY_CONNECTION_FAILED'), ctx(1)).action).toBe('switchProxy');
    });
    it('普通错误 attempt<max → 重试', () => {
        expect(policy.decide(new Error('transient timeout'), ctx(1)).action).toBe('retry');
    });
    it('普通错误重试耗尽 → 放弃', () => {
        expect(policy.decide(new Error('transient timeout'), ctx(3)).action).toBe('giveUp');
    });
});
