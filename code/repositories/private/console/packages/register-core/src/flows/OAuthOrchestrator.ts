/**
 * OAuth 流程编排器:驱动 OAuthFlow 状态机,捕获 localhost 回调换 token。
 * 支持 Phase 2(loginMethod=phone, stopAfterEmailBound:绑邮箱不取 token)
 * 与 Phase 3(loginMethod=email:邮箱登录换 token)。
 */
import type { BrowserAdapter } from '../browser/BrowserAdapter.js';
import type { PagePatterns } from '../state/pageDetector.js';
import { detectOAuthEvent } from '../state/pageDetector.js';
import { OAuthFlowDef } from '../state/OAuthFlow.js';
import { StateMachine } from '../state/machine.js';
import { Timing } from '../config/constants.js';
import { DEFAULT_SELECTOR_CONFIG, type RegistrationSelectorConfig } from '../config/selectors.js';
import { SignupActionError } from './SignupActionError.js';

export interface OAuthCallbacks {
    readonly onSmsCode: () => Promise<string>;
    readonly onEmailCode: () => Promise<string>;
}

export interface OAuthOptions {
    readonly loginMethod: 'phone' | 'email';
    readonly stopAfterEmailBound?: boolean;
    readonly redirectPort: number;
}

export interface OAuthRunResult {
    readonly callbackUrl: string | null;
    readonly emailBound: boolean;
}

export class OAuthOrchestrator {
    constructor(
        private readonly adapter: BrowserAdapter,
        private readonly patterns: PagePatterns,
        private readonly selectors: RegistrationSelectorConfig = DEFAULT_SELECTOR_CONFIG,
    ) {}

    async run(
        authUrl: string,
        identity: { phone: string; email: string; password: string; fullName: string },
        opts: OAuthOptions,
        callbacks: OAuthCallbacks,
    ): Promise<OAuthRunResult> {
        const sm = new StateMachine(OAuthFlowDef);
        sm.step('START');

        await this.adapter.goto(authUrl, { waitForCf: true, timeoutMs: Timing.CLOUDFLARE_TIMEOUT_MS });

        let callbackUrl: string | null = null;
        const unsubscribe = this.adapter.onRequestUrlMatch(
            (u) =>
                u.hostname === 'localhost' &&
                Number(u.port) === opts.redirectPort &&
                (u.searchParams.has('code') || u.searchParams.has('error')),
            (u) => {
                callbackUrl = u.toString();
                // 不在回调中推进状态机,避免与主循环 sm.step() 竞态。
                // 主循环开头统一检查 callbackUrl 并推进。
            },
        );

        let lastState = sm.current;
        try {
            for (let round = 0; round < Timing.OAUTH_MAX_ROUNDS && !sm.isTerminal() && !callbackUrl; round++) {
                // OAuth 回调是最优先事件:回调已捕获则立即推进并退出循环
                if (callbackUrl) {
                    sm.step('CALLBACK_RECEIVED');
                    break;
                }
                const snapshot = await this.adapter.snapshot();
                const event = detectOAuthEvent(snapshot, this.patterns, opts.loginMethod);
                sm.step(event, snapshot);
                if (sm.current !== lastState) {
                    await this.actOnState(sm.current, identity, opts, callbacks);
                    lastState = sm.current;
                }
                if (opts.stopAfterEmailBound && sm.current === 'AuthorizeConsent') break;
            }
        } finally {
            unsubscribe();
        }

        const emailBound = opts.stopAfterEmailBound === true;
        return { callbackUrl, emailBound };
    }

    private async actOnState(
        state: string,
        identity: { phone: string; email: string; password: string; fullName: string },
        opts: OAuthOptions,
        callbacks: OAuthCallbacks,
    ): Promise<void> {
        switch (state) {
            case 'LoginMethodSelect':
                await this.adapter
                    .clickButtonByText(opts.loginMethod === 'phone' ? '手机号' : '邮箱')
                    .catch((e) => { throw new SignupActionError(state, 'clickButton(loginMethod)', '选择登录方式失败', e); });
                break;
            case 'PhoneLogin':
                await this.adapter.setInputValue(this.selectors.signup.phoneInput, identity.phone).catch((e) => {
                    throw new SignupActionError(state, 'setInputValue(phone)', '填写手机号失败', e);
                });
                await this.adapter.clickButtonByText('继续', {
                    selector: this.selectors.signup.phoneSubmit,
                    debugName: 'oauth.phoneSubmit',
                }).catch((e) => {
                    throw new SignupActionError(state, 'clickButton(继续)', '点击继续按钮失败', e);
                });
                break;
            case 'EmailLogin':
            case 'EmailBindRequired':
                await this.adapter.setInputValue(this.selectors.oauth.emailInput, identity.email).catch((e) => {
                    throw new SignupActionError(state, 'setInputValue(email)', '填写邮箱失败', e);
                });
                await this.adapter.clickButtonByText('继续', {
                    selector: this.selectors.oauth.submit,
                    debugName: 'oauth.emailSubmit',
                }).catch((e) => {
                    throw new SignupActionError(state, 'clickButton(继续)', '点击继续按钮失败', e);
                });
                break;
            case 'PasswordEntry':
                await this.adapter.setInputValue(this.selectors.oauth.passwordInput, identity.password).catch((e) => {
                    throw new SignupActionError(state, 'setInputValue(password)', '填写 OAuth 密码失败', e);
                });
                await this.adapter.clickButtonByText('继续', {
                    selector: this.selectors.oauth.submit,
                    debugName: 'oauth.passwordSubmit',
                }).catch((e) => {
                    throw new SignupActionError(state, 'clickButton(继续)', '点击继续按钮失败', e);
                });
                break;
            case 'SmsCodeEntry': {
                const code = await callbacks.onSmsCode().catch((e) => {
                    throw new SignupActionError(state, 'onSmsCode', '获取 OAuth 短信验证码失败', e);
                });
                await this.adapter.setInputValue(this.selectors.smsCode.input, code).catch((e) => {
                    throw new SignupActionError(state, 'setInputValue(smsCode)', '填写 OAuth 短信码失败', e);
                });
                await this.adapter.clickButtonByText('继续', {
                    selector: this.selectors.oauth.submit,
                    debugName: 'oauth.smsSubmit',
                }).catch((e) => {
                    throw new SignupActionError(state, 'clickButton(继续)', '点击继续按钮失败', e);
                });
                break;
            }
            case 'EmailCodeEntry': {
                const code = await callbacks.onEmailCode().catch((e) => {
                    throw new SignupActionError(state, 'onEmailCode', '获取 OAuth 邮箱验证码失败', e);
                });
                await this.adapter.setInputValue(this.selectors.smsCode.input, code).catch((e) => {
                    throw new SignupActionError(state, 'setInputValue(emailCode)', '填写 OAuth 邮箱码失败', e);
                });
                await this.adapter.clickButtonByText('继续', {
                    selector: this.selectors.oauth.submit,
                    debugName: 'oauth.emailCodeSubmit',
                }).catch((e) => {
                    throw new SignupActionError(state, 'clickButton(继续)', '点击继续按钮失败', e);
                });
                break;
            }
            case 'AboutYou':
                await this.adapter.setInputValue(this.selectors.aboutYou.nameInput, identity.fullName).catch((e) => {
                    throw new SignupActionError(state, 'setInputValue(name)', '填写姓名失败', e);
                });
                await this.adapter.clickButtonByText('继续', {
                    selector: this.selectors.aboutYou.submit,
                    debugName: 'oauth.aboutYouSubmit',
                }).catch((e) => {
                    throw new SignupActionError(state, 'clickButton(继续)', '点击继续按钮失败', e);
                });
                break;
            case 'AuthorizeConsent':
                await this.adapter.clickButtonByText('授权', {
                    selector: this.selectors.oauth.submit,
                    debugName: 'oauth.authorizeSubmit',
                }).catch((e) => {
                    throw new SignupActionError(state, 'clickButton(授权)', '点击授权按钮失败', e);
                });
                break;
            case 'ErrorPage':
                await this.adapter.clickButtonByText('重试').catch((e) => {
                    throw new SignupActionError(state, 'clickButton(重试)', '点击重试按钮失败', e);
                });
                break;
            default:
                break;
        }
    }
}
