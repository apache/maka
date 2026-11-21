/**
 * OAuth 流程状态机定义(数据,非逻辑)。
 * 描述 Codex OAuth 两阶段(Phase 2 绑邮箱 / Phase 3 邮箱登录换 token)的状态转移。
 */
import type { MachineDef } from './machine.js';
import type { OAuthState } from './states.js';
import { OAUTH_TERMINAL_STATES } from './states.js';
import type { OAuthEvent } from './pageDetector.js';

const ACTIVE: readonly OAuthState[] = [
    'NavigatingAuth',
    'CloudflarePending',
    'LoginMethodSelect',
    'PhoneLogin',
    'EmailLogin',
    'PasswordEntry',
    'SmsCodeEntry',
    'EmailCodeEntry',
    'AboutYou',
    'EmailBindRequired',
    'AuthorizeConsent',
    'ErrorPage',
];

export const OAuthFlowDef: MachineDef<OAuthState, OAuthEvent> = {
    initial: 'Idle',
    terminals: OAUTH_TERMINAL_STATES,
    transitions: [
        { from: ['Idle'], on: 'START', to: 'NavigatingAuth' },
        // 回调捕获是终态事件,任何状态都可进入
        { from: ['Idle', ...ACTIVE], on: 'CALLBACK_RECEIVED', to: 'CallbackReceived' },
        { from: ACTIVE, on: 'CF_DETECTED', to: 'CloudflarePending' },
        { from: ['NavigatingAuth', 'CloudflarePending', 'ErrorPage'], on: 'LOGIN_METHOD_PHONE', to: 'PhoneLogin' },
        { from: ['NavigatingAuth', 'CloudflarePending', 'ErrorPage'], on: 'LOGIN_METHOD_EMAIL', to: 'EmailLogin' },
        { from: ['NavigatingAuth', 'CloudflarePending', 'ErrorPage'], on: 'PHONE_INPUT_READY', to: 'PhoneLogin' },
        { from: ['NavigatingAuth', 'CloudflarePending', 'EmailBindRequired', 'ErrorPage'], on: 'EMAIL_INPUT_READY', to: 'EmailLogin' },
        { from: ['PhoneLogin', 'EmailLogin', 'CloudflarePending'], on: 'PASSWORD_READY', to: 'PasswordEntry' },
        { from: ['PasswordEntry', 'CloudflarePending'], on: 'SMS_CODE_READY', to: 'SmsCodeEntry' },
        { from: ['PasswordEntry', 'CloudflarePending'], on: 'EMAIL_CODE_READY', to: 'EmailCodeEntry' },
        { from: ['PasswordEntry', 'SmsCodeEntry', 'EmailCodeEntry', 'CloudflarePending'], on: 'ABOUT_YOU_READY', to: 'AboutYou' },
        { from: ['EmailCodeEntry', 'EmailBindRequired', 'AboutYou', 'CloudflarePending'], on: 'EMAIL_BOUND', to: 'AuthorizeConsent' },
        { from: ACTIVE, on: 'ERROR_PAGE', to: 'ErrorPage' },
        { from: ACTIVE, on: 'ACCOUNT_DEACTIVATED', to: 'AccountDeactivated' },
        { from: ACTIVE, on: 'GOOGLE_SSO', to: 'GoogleSsoHijack' },
        { from: ACTIVE, on: 'RATE_LIMITED', to: 'ErrorPage' },
        { from: ACTIVE, on: 'UNUSUAL_ACTIVITY', to: 'ErrorPage' },
        { from: ACTIVE, on: 'TIMEOUT', to: 'Failed' },
    ],
};
