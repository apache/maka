import { describe, it, expect } from 'vitest';
import {
    generateIdentity,
    generatePassword,
    generateFullName,
    generateBirthDate,
} from '../../src/flows/IdentityGenerator.js';

describe('IdentityGenerator', () => {
    it('密码满足强度(大小写+数字+符号)且以 A1! 结尾', () => {
        const pwd = generatePassword();
        expect(pwd).toMatch(/[a-z]/);
        expect(pwd).toMatch(/[A-Z]/);
        expect(pwd).toMatch(/\d/);
        expect(pwd).toMatch(/[!@#$]/);
        expect(pwd.endsWith('A1!')).toBe(true);
        expect(pwd.length).toBeGreaterThanOrEqual(19); // 16 + A1!
    });
    it('姓名含空格(名 姓)', () => {
        expect(generateFullName()).toMatch(/.+\s.+/);
    });
    it('生日格式 YYYY-MM-DD 且年龄在区间内', () => {
        const { age, birthDate } = generateBirthDate();
        expect(birthDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(age).toBeGreaterThanOrEqual(25);
        expect(age).toBeLessThanOrEqual(40);
    });
    it('完整身份字段齐全', () => {
        const id = generateIdentity();
        expect(id.fullName).toBeTruthy();
        expect(id.password).toBeTruthy();
        expect(id.birthDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(id.age).toBeGreaterThan(0);
    });
});
