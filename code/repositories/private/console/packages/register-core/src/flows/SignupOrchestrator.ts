/**
 * 注册流程编排器:驱动 SignupFlow 状态机,按当前状态调用 adapter/provider。
 * 这是把现有 browserService.completeProfile 的 20 轮隐式循环外提为"状态机 + 动作分派"的产物。
 * 每轮:snapshot → detectSignupEvent → 状态机 step → 按当前状态执行动作。
 *
 * 注:本骨架体现架构(状态机驱动决策、动作与决策分离);完整生产细节(国家选择器三种 UI、
 * 密码页 A/B 自适应、about-you 多字段)按 selectors.json + DomKit 增量,此处给出主干。
 */
import type { BrowserAdapter } from '../browser/BrowserAdapter.js';
import type { SmsProvider } from '../providers/sms/SmsProvider.js';
import type { PagePatterns, SignupEvent } from '../state/pageDetector.js';
import { detectSignupEvent } from '../state/pageDetector.js';
import { SignupFlowDef } from '../state/SignupFlow.js';
import { StateMachine } from '../state/machine.js';
import { Timing } from '../config/constants.js';
import { DEFAULT_SELECTOR_CONFIG, type RegistrationSelectorConfig } from '../config/selectors.js';
import type { Identity } from './IdentityGenerator.js';
import { SignupActionError } from './SignupActionError.js';

export interface SignupCallbacks {
    readonly onSmsCode: () => Promise<string>;
}

export interface SignupResult {
    readonly phone: string;
    readonly activationId: string | number;
}

const SIGNUP_URL = 'https://chatgpt.com';

export function normalizePhoneForInput(phone: string): string {
    const trimmed = phone.trim();
    return trimmed.startsWith('+') ? trimmed.slice(1) : trimmed;
}

export class SignupOrchestrator {
    constructor(
        private readonly adapter: BrowserAdapter,
        private readonly sms: SmsProvider,
        private readonly patterns: PagePatterns,
        private readonly selectors: RegistrationSelectorConfig = DEFAULT_SELECTOR_CONFIG,
    ) {}

    async run(
        identity: Identity,
        service: string,
        country: number,
        callbacks: SignupCallbacks,
    ): Promise<SignupResult> {
        const sm = new StateMachine(SignupFlowDef);
        sm.step('START');

        await this.adapter.goto(SIGNUP_URL, { waitForCf: true, timeoutMs: Timing.CLOUDFLARE_TIMEOUT_MS });

        // 浏览器就绪后再买号(花钱操作尽量靠后,失败可重试)
        const acquired = await this.sms.getNumber(service, country);
        await this.sms.markReady();

        const phone = acquired.phoneNumber;
        let lastState = sm.current;

        for (let round = 0; round < Timing.SIGNUP_MAX_ROUNDS && !sm.isTerminal(); round++) {
            const snapshot = await this.adapter.snapshot();
            const event: SignupEvent = detectSignupEvent(snapshot, this.patterns);
            sm.step(event, snapshot);

            // 仅在状态变化时执行动作,避免重复输入
            if (sm.current !== lastState) {
                await this.actOnState(sm.current, identity, phone, callbacks);
                lastState = sm.current;
            }
        }

        if (sm.current !== 'Completed') {
            await this.sms.cancel();
            throw new Error(`注册流程未完成,最终状态: ${sm.current}`);
        }
        await this.sms.complete();
        return { phone, activationId: acquired.activationId };
    }

    private async actOnState(
        state: string,
        identity: Identity,
        phone: string,
        callbacks: SignupCallbacks,
    ): Promise<void> {
        switch (state) {
            case 'PhoneEntry': {
                const local = normalizePhoneForInput(phone);
                await this.adapter.setInputValue(this.selectors.signup.phoneInput, local).catch((e) => {
                    throw new SignupActionError(state, 'setInputValue(phone)', '填写手机号失败', e);
                });
                await this.adapter.clickButtonByText('继续', {
                    selector: this.selectors.signup.phoneSubmit,
                    debugName: 'signup.phoneSubmit',
                }).catch((e) => {
                    throw new SignupActionError(state, 'clickButton(继续)', '点击继续按钮失败', e);
                });
                break;
            }
            case 'PasswordEntry': {
                await this.adapter.setInputValue(this.selectors.password.input, identity.password).catch((e) => {
                    throw new SignupActionError(state, 'setInputValue(password)', '填写密码失败', e);
                });
                await this.adapter.clickButtonByText('继续', {
                    selector: this.selectors.password.submit,
                    debugName: 'password.submit',
                }).catch((e) => {
                    throw new SignupActionError(state, 'clickButton(继续)', '点击继续按钮失败', e);
                });
                break;
            }
            case 'SmsCodeEntry': {
                const code = await callbacks.onSmsCode().catch((e) => {
                    throw new SignupActionError(state, 'onSmsCode', '获取短信验证码失败', e);
                });
                await this.adapter.setInputValue(this.selectors.smsCode.input, code).catch((e) => {
                    throw new SignupActionError(state, 'setInputValue(smsCode)', '填写短信验证码失败', e);
                });
                await this.adapter.clickButtonByText('继续', {
                    selector: this.selectors.password.submit,
                    debugName: 'smsCode.submit',
                }).catch((e) => {
                    throw new SignupActionError(state, 'clickButton(继续)', '点击继续按钮失败', e);
                });
                break;
            }
            case 'AboutYou': {
                await this.adapter.setInputValue(this.selectors.aboutYou.nameInput, identity.fullName).catch((e) => {
                    throw new SignupActionError(state, 'setInputValue(name)', '填写姓名失败', e);
                });
                await this.adapter.clickButtonByText('继续', {
                    selector: this.selectors.aboutYou.submit,
                    debugName: 'aboutYou.submit',
                }).catch((e) => {
                    throw new SignupActionError(state, 'clickButton(继续)', '点击继续按钮失败', e);
                });
                break;
            }
            case 'ErrorPage': {
                await this.adapter.clickButtonByText('重试').catch((e) => {
                    throw new SignupActionError(state, 'clickButton(重试)', '点击重试按钮失败', e);
                });
                break;
            }
            default:
                break;
        }
    }
}
