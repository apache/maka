import { describe, it, expect } from 'vitest';
import { detectSignupEvent, detectOAuthEvent, type PagePatterns } from '../../src/state/pageDetector.js';
import type { PageSnapshot } from '../../src/state/states.js';

const patterns: PagePatterns = {
    urlPatterns: {
        signup: ['auth.openai.com'],
        chatgptHome: ['chatgpt.com'],
        authorize: ['/oauth/'],
        googleAccounts: ['accounts.google.com'],
        aboutYou: ['about-you'],
        contactVerification: ['contact-verification'],
        emailVerification: ['email-verification'],
        addEmail: ['add-email'],
    },
    pageStateText: {
        password: ['create password', '密码'],
        smsCode: ['验证码', 'code we texted'],
        emailCode: ['check your email', '邮箱验证码'],
        aboutYou: ['tell us about you', '生日'],
        errorPage: ['something went wrong', '出错了'],
        phoneRegistered: ['already associated'],
        accountDeactivated: ['account_deactivated'],
        loginMethod: ['continue with phone', 'log in'],
        authorize: ['authorize', '授权'],
    },
};

function snap(p: Partial<PageSnapshot>): PageSnapshot {
    return { url: '', title: '', text: '', inputs: [], buttonLabels: [], hasCfChallenge: false, errorType: null, errorContext: '', capturedAt: 0, ...p };
}

describe('detectSignupEvent', () => {
    it('CF 挑战', () => {
        expect(detectSignupEvent(snap({ hasCfChallenge: true }), patterns)).toBe('CF_DETECTED');
    });
    it('完成到 chatgpt 主页', () => {
        expect(detectSignupEvent(snap({ url: 'https://chatgpt.com/' }), patterns)).toBe('COMPLETED');
    });
    it('密码页', () => {
        expect(detectSignupEvent(snap({ text: 'Create password' }), patterns)).toBe('PASSWORD_READY');
    });
    it('手机号输入框', () => {
        const s = snap({ url: 'https://auth.openai.com/log-in', inputs: [{ type: 'tel', name: 'phoneNumberInput', visible: true }] });
        expect(detectSignupEvent(s, patterns)).toBe('PHONE_INPUT_READY');
    });
    it('手机号已注册(致命)', () => {
        expect(detectSignupEvent(snap({ text: 'this phone number is already associated' }), patterns)).toBe('PHONE_REGISTERED');
    });
    it('无信号返回 IDLE', () => {
        expect(detectSignupEvent(snap({}), patterns)).toBe('IDLE');
    });
});

describe('detectOAuthEvent', () => {
    it('邮箱验证码页', () => {
        expect(detectOAuthEvent(snap({ url: 'https://auth.openai.com/email-verification' }), patterns, 'email')).toBe('EMAIL_CODE_READY');
    });
    it('登录方式选择(phone)', () => {
        expect(detectOAuthEvent(snap({ text: 'Continue with phone' }), patterns, 'phone')).toBe('LOGIN_METHOD_PHONE');
    });
    it('授权按钮', () => {
        expect(detectOAuthEvent(snap({ text: 'Authorize access' }), patterns, 'email')).toBe('EMAIL_BOUND');
    });
});
