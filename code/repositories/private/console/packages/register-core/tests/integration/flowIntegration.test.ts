/**
 * 离线集成测试:用 MockBrowserAdapter + 假接码 provider,跑通完整 Phase 1 注册编排。
 * 证明 SignupOrchestrator 的状态机驱动 + adapter 调用 + sms 生命周期真的按设计串联工作。
 * 全程不接触任何真实服务(无浏览器、无网络、无真实接码)。
 */
import { describe, it, expect } from 'vitest';
import { MockBrowserAdapter } from '../../src/browser/MockBrowserAdapter.js';
import { SignupOrchestrator } from '../../src/flows/SignupOrchestrator.js';
import { generateIdentity } from '../../src/flows/IdentityGenerator.js';
import type {
    SmsProvider,
    AcquiredNumber,
    SmsPollOptions,
    SmsStatus,
} from '../../src/providers/sms/SmsProvider.js';
import { asOtp, asPhone, type OtpCode, type PhoneNumber } from '../../src/types/brand.js';
import type { PageSnapshot } from '../../src/state/states.js';
import type { PagePatterns } from '../../src/state/pageDetector.js';
import type { RegistrationSelectorConfig } from '../../src/config/selectors.js';

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
        smsCode: ['验证码', 'code'],
        emailCode: ['check your email'],
        aboutYou: ['tell us about you'],
        errorPage: ['something went wrong', '出错了'],
        phoneRegistered: ['already associated'],
        accountDeactivated: ['account_deactivated'],
        loginMethod: ['continue with phone', 'log in'],
        authorize: ['authorize', '授权'],
    },
};

const customSelectors: RegistrationSelectorConfig = {
    signup: {
        phoneInput: "input[data-testid='phone']",
        phoneSubmit: "button[data-testid='phone-submit']",
    },
    password: {
        input: "input[data-testid='password']",
        submit: "button[data-testid='password-submit']",
    },
    aboutYou: {
        nameInput: "input[data-testid='name']",
        birthInput: "input[data-testid='birth']",
        ageInput: "input[data-testid='age']",
        submit: "button[data-testid='about-submit']",
    },
    oauth: {
        emailInput: "input[data-testid='email']",
        passwordInput: "input[data-testid='oauth-password']",
        submit: "button[data-testid='oauth-submit']",
    },
    smsCode: {
        input: "input[data-testid='sms-code']",
    },
    cloudflare: {
        titleHints: ['just a moment'],
        bodyHints: ['turnstile'],
    },
};

function snap(p: Partial<PageSnapshot>): PageSnapshot {
    return { url: '', title: '', text: '', inputs: [], buttonLabels: [], hasCfChallenge: false, errorType: null, errorContext: '', capturedAt: 0, ...p };
}

class FakeSmsProvider implements SmsProvider {
    readonly name = 'herosms' as const;
    public completed = false;
    public cancelled = false;
    public pollCalls = 0;

    async getNumber(_service: string, _country: number | string, _maxRetries?: number): Promise<AcquiredNumber> {
        return { activationId: 9001, phoneNumber: asPhone('+447123456789'), costUsd: 0.12 };
    }
    async markReady(): Promise<void> {
        /* no-op */
    }
    async getStatus(): Promise<SmsStatus> {
        return { received: false };
    }
    async pollForCode(_opts?: SmsPollOptions): Promise<OtpCode> {
        this.pollCalls++;
        return asOtp('482910');
    }
    async complete(): Promise<void> {
        this.completed = true;
    }
    async cancel(): Promise<void> {
        this.cancelled = true;
    }
    getPhone(): PhoneNumber | null {
        return asPhone('+447123456789');
    }
}

describe('离线集成:Phase 1 注册流程完整编排', () => {
    it('Mock 浏览器 + 假接码,状态机从 Idle 推进到 Completed 并正确调用 adapter', async () => {
        const adapter = new MockBrowserAdapter();
        // 预设页面快照序列,精确对应注册流程每一步
        adapter.queueSnapshots([
            snap({ hasCfChallenge: true }), // → CloudflarePending
            snap({
                url: 'https://auth.openai.com/log-in',
                inputs: [{ type: 'tel', name: 'phoneNumberInput', visible: true }],
            }), // → PhoneEntry
            snap({ text: 'Create password' }), // → PasswordEntry
            snap({ url: 'https://auth.openai.com/contacti-verification', text: 'enter the code' }), // → SmsCodeEntry
            snap({ url: 'https://auth.openai.com/about-you' }), // → AboutYou
            snap({ url: 'https://chatgpt.com/' }), // → Completed
        ]);

        const sms = new FakeSmsProvider();
        const orch = new SignupOrchestrator(adapter, sms, patterns, customSelectors);
        const identity = generateIdentity();

        const result = await orch.run(identity, 'dr', 16, {
            onSmsCode: () => sms.pollForCode(),
        });

        // 结果正确
        expect(result.phone).toBe('+447123456789');
        expect(result.activationId).toBe(9001);

        // SMS 生命周期:成功结算,未取消
        expect(sms.completed).toBe(true);
        expect(sms.cancelled).toBe(false);
        expect(sms.pollCalls).toBe(1);

        // 浏览器被正确驱动:导航 + 每步输入 + 每步点继续
        expect(adapter.callCount('goto')).toBeGreaterThanOrEqual(1);
        expect(adapter.callCount('setInputValue')).toBe(4); // 手机号 / 密码 / 验证码 / 姓名
        expect(adapter.callCount('clickButtonByText')).toBeGreaterThanOrEqual(4);

        // setInputValue 的参数确实传了正确的值
        const inputs = adapter.calls.filter((c) => c.method === 'setInputValue').map((c) => c.args[1]);
        expect(inputs).toContain('447123456789'); // 保留可输入数字,避免把 + 后全部数字清空导致按钮不可提交
        expect(inputs).toContain(identity.password);
        expect(inputs).toContain('482910'); // SMS 验证码
        expect(inputs).toContain(identity.fullName);

        const setInputCalls = adapter.calls.filter((c) => c.method === 'setInputValue');
        expect(setInputCalls.map((c) => c.args[0])).toEqual([
            customSelectors.signup.phoneInput,
            customSelectors.password.input,
            customSelectors.smsCode.input,
            customSelectors.aboutYou.nameInput,
        ]);

        const clickCalls = adapter.calls.filter((c) => c.method === 'clickButtonByText');
        expect(clickCalls[0]?.args[1]).toMatchObject({ selector: customSelectors.signup.phoneSubmit });
        expect(clickCalls[1]?.args[1]).toMatchObject({ selector: customSelectors.password.submit });
        expect(clickCalls[2]?.args[1]).toMatchObject({ selector: customSelectors.password.submit });
        expect(clickCalls[3]?.args[1]).toMatchObject({ selector: customSelectors.aboutYou.submit });
    });

    it('致命状态(手机号已注册)正确触发 cancel 并抛错', async () => {
        const adapter = new MockBrowserAdapter();
        adapter.queueSnapshots([
            snap({ hasCfChallenge: true }),
            snap({
                url: 'https://auth.openai.com/log-in',
                text: 'this phone number is already associated with an account',
            }), // → PhoneAlreadyRegistered(终态)
        ]);
        const sms = new FakeSmsProvider();
        const orch = new SignupOrchestrator(adapter, sms, patterns);

        await expect(orch.run(generateIdentity(), 'dr', 16, { onSmsCode: () => sms.pollForCode() })).rejects.toThrow(
            /未完成/,
        );
        // 致命终态应触发退款(cancel),而不是 complete
        expect(sms.cancelled).toBe(true);
        expect(sms.completed).toBe(false);
    });
});
