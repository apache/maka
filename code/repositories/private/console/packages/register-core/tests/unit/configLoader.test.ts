import { describe, it, expect } from 'vitest';
import { envToConfig, deepMerge, validateBusinessRules, ConfigValidationError } from '../../src/config/loader.js';
import { AppConfigSchema } from '../../src/config/schema.js';
import { normalizeSelectorConfig } from '../../src/config/selectors.js';
import { normalizePhoneForInput } from '../../src/flows/SignupOrchestrator.js';

describe('envToConfig', () => {
    it('映射 SMS 字段', () => {
        const cfg = envToConfig({ HERO_SMS_API_KEY: 'k', REG_SMS_PROVIDER: 'herosms' });
        expect((cfg as any).sms.herosms.apiKey).toBe('k');
        expect((cfg as any).sms.provider).toBe('herosms');
    });
    it('映射 proxy', () => {
        const cfg = envToConfig({ PROXY_HOST: 'h', PROXY_PORT: '8080' });
        expect((cfg as any).proxy.host).toBe('h');
        expect((cfg as any).proxy.port).toBe(8080);
    });
    it('空字符串 env 不覆盖对应字段(但数字字段有默认值仍设置)', () => {
        const cfg = envToConfig({ HERO_SMS_API_KEY: '' });
        expect((cfg as any).sms?.herosms?.apiKey).toBeUndefined();
        expect((cfg as any).sms?.herosms?.country).toBe(16); // 数字字段默认值
    });
});

describe('deepMerge', () => {
    it('嵌套对象合并', () => {
        const r = deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } });
        expect(r.a).toEqual({ b: 1, c: 3 });
    });
    it('undefined 不覆盖', () => {
        const r = deepMerge({ a: 1 }, { a: undefined });
        expect(r.a).toBe(1);
    });
});

describe('validateBusinessRules', () => {
    it('herosms 无 key 抛 ConfigValidationError', () => {
        const cfg = AppConfigSchema.parse({ sms: { provider: 'herosms', herosms: {} }, mail: { provider: 'legacy', legacy: { baseUrl: 'u', adminPassword: 'p', domain: 'd' } } });
        expect(() => validateBusinessRules(cfg)).toThrow(ConfigValidationError);
    });
    it('herosms 有 key 通过', () => {
        const cfg = AppConfigSchema.parse({ sms: { provider: 'herosms', herosms: { apiKey: 'k' } }, mail: { provider: 'legacy', legacy: { baseUrl: 'u', adminPassword: 'p', domain: 'd' } } });
        expect(() => validateBusinessRules(cfg)).not.toThrow();
    });
    it('legacy 缺 domain 抛错', () => {
        const cfg = AppConfigSchema.parse({ sms: { provider: 'herosms', herosms: { apiKey: 'k' } }, mail: { provider: 'legacy', legacy: { baseUrl: 'u', adminPassword: 'p' } } });
        expect(() => validateBusinessRules(cfg)).toThrow(/MAIL_DOMAIN/);
    });
    it('映射 IMAP 字段', () => {
        const cfg = envToConfig({
            IMAP_USER: 'me@gmail.com',
            IMAP_PASSWORD: 'app-pass',
            IMAP_HOST: 'imap.gmail.com',
            IMAP_PORT: '993',
        });
        expect((cfg as any).mail.imap.user).toBe('me@gmail.com');
        expect((cfg as any).mail.imap.password).toBe('app-pass');
        expect((cfg as any).mail.imap.host).toBe('imap.gmail.com');
        expect((cfg as any).mail.imap.port).toBe(993);
    });
    it('IMAP 缺 user 抛 ConfigValidationError', () => {
        const cfg = AppConfigSchema.parse({
            sms: { provider: 'herosms', herosms: { apiKey: 'k' } },
            mail: { provider: 'imap', imap: { user: '', password: '' } },
        });
        expect(() => validateBusinessRules(cfg)).toThrow(/IMAP_USER/);
    });
    it('IMAP 有凭据通过', () => {
        const cfg = AppConfigSchema.parse({
            sms: { provider: 'herosms', herosms: { apiKey: 'k' } },
            mail: { provider: 'imap', imap: { user: 'me@gmail.com', password: 'app-pass' } },
        });
        expect(() => validateBusinessRules(cfg)).not.toThrow();
    });
});

describe('selector 与输入归一化', () => {
    it('normalizeSelectorConfig 只覆盖指定字段,其余保持默认', () => {
        const cfg = normalizeSelectorConfig({
            signup: { phoneInput: "input[data-testid='phone']" },
        });
        expect(cfg.signup.phoneInput).toBe("input[data-testid='phone']");
        expect(cfg.signup.phoneSubmit).toBe("button[type='submit']");
        expect(cfg.password.input).toContain("input[type='password']");
    });

    it('normalizePhoneForInput 不会把 + 后的全部数字清空', () => {
        expect(normalizePhoneForInput('+447123456789')).toBe('447123456789');
        expect(normalizePhoneForInput(' 447123456789 ')).toBe('447123456789');
    });
});
