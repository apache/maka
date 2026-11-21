import { describe, it, expect } from 'vitest';
import { StateMachine } from '../../src/state/machine.js';
import { SignupFlowDef } from '../../src/state/SignupFlow.js';
import { OAuthFlowDef } from '../../src/state/OAuthFlow.js';

describe('StateMachine (SignupFlow)', () => {
    it('初始状态为 Idle,非终态', () => {
        const sm = new StateMachine(SignupFlowDef);
        expect(sm.current).toBe('Idle');
        expect(sm.isTerminal()).toBe(false);
    });
    it('推进正常序列 Idle→Navigating→CF→Phone', () => {
        const sm = new StateMachine(SignupFlowDef);
        sm.step('START');
        sm.step('CF_DETECTED');
        sm.step('PHONE_INPUT_READY');
        expect(sm.current).toBe('PhoneEntry');
    });
    it('完成路径到达终态', () => {
        const sm = new StateMachine(SignupFlowDef);
        sm.step('START');
        sm.step('PHONE_INPUT_READY');
        sm.step('PASSWORD_READY');
        sm.step('SMS_CODE_READY');
        sm.step('ABOUT_YOU_READY');
        sm.step('COMPLETED');
        expect(sm.current).toBe('Completed');
        expect(sm.isTerminal()).toBe(true);
    });
    it('致命事件进入终态', () => {
        const sm = new StateMachine(SignupFlowDef);
        sm.step('START');
        sm.step('PHONE_REGISTERED');
        expect(sm.current).toBe('PhoneAlreadyRegistered');
        expect(sm.isTerminal()).toBe(true);
    });
    it('非法事件不推进(返回 false)', () => {
        const sm = new StateMachine(SignupFlowDef);
        expect(sm.step('PHONE_INPUT_READY')).toBe(false);
        expect(sm.current).toBe('Idle');
    });
    it('run 返回状态轨迹', () => {
        const sm = new StateMachine(SignupFlowDef);
        const trace = sm.run([{ event: 'START' }, { event: 'PHONE_INPUT_READY' }]);
        expect(trace).toEqual(['Idle', 'NavigatingSignup', 'PhoneEntry']);
    });
    it('记录转移轨迹', () => {
        const sm = new StateMachine(SignupFlowDef);
        sm.step('START');
        sm.step('CF_DETECTED');
        expect(sm.getTrace()).toHaveLength(2);
        expect(sm.getTrace()[1]!.to).toBe('CloudflarePending');
    });
});

describe('StateMachine (OAuthFlow)', () => {
    it('CALLBACK_RECEIVED 直接终态', () => {
        const sm = new StateMachine(OAuthFlowDef);
        sm.step('START');
        sm.step('CALLBACK_RECEIVED');
        expect(sm.current).toBe('CallbackReceived');
        expect(sm.isTerminal()).toBe(true);
    });
});
