import { describe, it, expect } from 'vitest';
import { extractSmsCode } from '../../src/providers/sms/smsCodeParser.js';

describe('extractSmsCode', () => {
    it('关键词后提取 4-8 位', () => {
        expect(extractSmsCode('Your code is 123456')).toBe('123456');
        expect(extractSmsCode('验证码: 654321')).toBe('654321');
        expect(extractSmsCode('verification 4829')).toBe('4829');
    });
    it('关键词前提取', () => {
        expect(extractSmsCode('123456 is your verification code')).toBe('123456');
    });
    it('兜底提取独立数字串', () => {
        expect(extractSmsCode('Hello 482910 bye')).toBe('482910');
    });
    it('无验证码返回 null', () => {
        expect(extractSmsCode('no digits here')).toBeNull();
        expect(extractSmsCode('')).toBeNull();
    });
});
