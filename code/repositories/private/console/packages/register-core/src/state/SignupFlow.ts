/**
 * 注册流程状态机定义(数据,非逻辑)。
 * 描述 ChatGPT 手机号注册的状态转移。所有非终态状态共用一组"错误/致命/超时"转移。
 */
import type { MachineDef } from './machine.js';
import type { SignupState } from './states.js';
import { SIGNUP_TERMINAL_STATES } from './states.js';
import type { SignupEvent } from './pageDetector.js';

/** 活跃(非终态)状态:错误/致命/超时事件可从这些状态触发。 */
const ACTIVE: readonly SignupState[] = [
    'NavigatingSignup',
    'CloudflarePending',
    'PhoneEntry',
    'PasswordEntry',
    'SmsCodeEntry',
    'AboutYou',
    'ErrorPage',
];

export const SignupFlowDef: MachineDef<SignupState, SignupEvent> = {
    initial: 'Idle',
    terminals: SIGNUP_TERMINAL_STATES,
    transitions: [
        { from: ['Idle'], on: 'START', to: 'NavigatingSignup' },
        { from: ACTIVE, on: 'CF_DETECTED', to: 'CloudflarePending' },
        { from: ['NavigatingSignup', 'CloudflarePending', 'ErrorPage'], on: 'PHONE_INPUT_READY', to: 'PhoneEntry' },
        { from: ['PhoneEntry', 'CloudflarePending'], on: 'PASSWORD_READY', to: 'PasswordEntry' },
        { from: ['PhoneEntry', 'PasswordEntry', 'CloudflarePending'], on: 'SMS_CODE_READY', to: 'SmsCodeEntry' },
        { from: ['PasswordEntry', 'SmsCodeEntry', 'CloudflarePending'], on: 'ABOUT_YOU_READY', to: 'AboutYou' },
        { from: ['AboutYou', 'CloudflarePending'], on: 'COMPLETED', to: 'Completed' },
        { from: ACTIVE, on: 'ERROR_PAGE', to: 'ErrorPage' },
        { from: ACTIVE, on: 'PHONE_REGISTERED', to: 'PhoneAlreadyRegistered' },
        { from: ACTIVE, on: 'ACCOUNT_DEACTIVATED', to: 'AccountDeactivated' },
        { from: ACTIVE, on: 'GOOGLE_SSO', to: 'GoogleSsoHijack' },
        { from: ACTIVE, on: 'RATE_LIMITED', to: 'ErrorPage' },
        { from: ACTIVE, on: 'UNUSUAL_ACTIVITY', to: 'ErrorPage' },
        { from: ACTIVE, on: 'TIMEOUT', to: 'Failed' },
    ],
};
