import { describe, it, expect } from 'vitest';
import { extractMailCode } from '../../src/providers/mail/mailCodeParser.js';

describe('extractMailCode', () => {
    it('关键词后 6 位', () => {
        expect(extractMailCode('Your verification code: 123456')).toBe('123456');
        expect(extractMailCode('验证码 654321')).toBe('654321');
    });
    it('关键词前 6 位', () => {
        expect(extractMailCode('112233 is your verification code')).toBe('112233');
    });
    it('HTML 标签间 6 位', () => {
        expect(extractMailCode('<span>654321</span>')).toBe('654321');
    });
    it('兜底过滤 t=/x= 噪声', () => {
        const body = 't=111111 222333';
        expect(extractMailCode(body, body)).toBe('222333');
    });
    it('无码返回 null', () => {
        expect(extractMailCode('just text no digits')).toBeNull();
    });
});
