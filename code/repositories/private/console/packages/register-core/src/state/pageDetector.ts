/**
 * 页面状态检测器(纯函数):把 PageSnapshot + 文案/URL 模式 → 语义事件。
 * 这是把现有 browserService 里 `if (url.includes('password')) ...` 隐式逻辑
 * 外提为纯函数的核心。所有"当前页面是哪一步"的判定集中于此,可单测。
 */
import type { PageSnapshot } from './states.js';

/** 文案/URL 模式集合(从 config/i18n.json 加载注入,便于测试与多语言)。 */
export interface PagePatterns {
    readonly urlPatterns: {
        readonly signup: readonly string[];
        readonly chatgptHome: readonly string[];
        readonly authorize: readonly string[];
        readonly googleAccounts: readonly string[];
        readonly aboutYou: readonly string[];
        readonly contactVerification: readonly string[];
        readonly emailVerification: readonly string[];
        readonly addEmail: readonly string[];
    };
    readonly pageStateText: {
        readonly password: readonly string[];
        readonly smsCode: readonly string[];
        readonly emailCode: readonly string[];
        readonly aboutYou: readonly string[];
        readonly errorPage: readonly string[];
        readonly phoneRegistered: readonly string[];
        readonly accountDeactivated: readonly string[];
        readonly loginMethod: readonly string[];
        readonly authorize: readonly string[];
    };
}

/** 注册流程事件。START/TIMEOUT 由 orchestrator 产生,其余由 detectSignupEvent 产生。 */
export type SignupEvent =
    | 'START'
    | 'CF_DETECTED'
    | 'PHONE_INPUT_READY'
    | 'PASSWORD_READY'
    | 'SMS_CODE_READY'
    | 'ABOUT_YOU_READY'
    | 'COMPLETED'
    | 'ERROR_PAGE'
    | 'PHONE_REGISTERED'
    | 'ACCOUNT_DEACTIVATED'
    | 'GOOGLE_SSO'
    | 'RATE_LIMITED'
    | 'UNUSUAL_ACTIVITY'
    | 'TIMEOUT'
    | 'IDLE';

/** OAuth 流程事件。 */
export type OAuthEvent =
    | 'START'
    | 'CF_DETECTED'
    | 'LOGIN_METHOD_PHONE'
    | 'LOGIN_METHOD_EMAIL'
    | 'PHONE_INPUT_READY'
    | 'EMAIL_INPUT_READY'
    | 'PASSWORD_READY'
    | 'SMS_CODE_READY'
    | 'EMAIL_CODE_READY'
    | 'ABOUT_YOU_READY'
    | 'EMAIL_BOUND'
    | 'CALLBACK_RECEIVED'
    | 'ERROR_PAGE'
    | 'ACCOUNT_DEACTIVATED'
    | 'GOOGLE_SSO'
    | 'RATE_LIMITED'
    | 'UNUSUAL_ACTIVITY'
    | 'TIMEOUT'
    | 'IDLE';

function includesAny(haystack: string, needles: readonly string[]): boolean {
    if (needles.length === 0) return false;
    const h = haystack.toLowerCase();
    return needles.some((n) => h.includes(n.toLowerCase()));
}

function hasInputMatching(
    inputs: PageSnapshot['inputs'],
    pred: (i: PageSnapshot['inputs'][number]) => boolean,
): boolean {
    return inputs.some(pred);
}

const ALL_NONTERMINAL = [
    'Idle',
    'NavigatingSignup',
    'CloudflarePending',
    'PhoneEntry',
    'PasswordEntry',
    'SmsCodeEntry',
    'AboutYou',
    'ErrorPage',
] as const;

/**
 * 注册流程:从快照推断应触发的事件。优先级:CF > 致命 > 完成 > 错误 > about > sms > password > phone。
 */
export function detectSignupEvent(snapshot: PageSnapshot, p: PagePatterns): SignupEvent {
    const { url, text, inputs, hasCfChallenge } = snapshot;

    // 最高优先级:浏览器内错误扫描(在完整未截断文本上执行,不依赖 URL 匹配)
    if (snapshot.errorType === 'phone_registered') return 'PHONE_REGISTERED';
    if (snapshot.errorType === 'account_deactivated') return 'ACCOUNT_DEACTIVATED';
    if (snapshot.errorType === 'google_sso_redirect') return 'GOOGLE_SSO';
    if (snapshot.errorType === 'rate_limited') return 'RATE_LIMITED';
    if (snapshot.errorType === 'unusual_activity') return 'UNUSUAL_ACTIVITY';

    if (hasCfChallenge) return 'CF_DETECTED';
    if (includesAny(url, p.urlPatterns.googleAccounts)) return 'GOOGLE_SSO';
    if (includesAny(text, p.pageStateText.phoneRegistered)) return 'PHONE_REGISTERED';
    if (includesAny(text, p.pageStateText.accountDeactivated)) return 'ACCOUNT_DEACTIVATED';

    const onChatgpt = includesAny(url, p.urlPatterns.chatgptHome);
    const onAuth = includesAny(url, p.urlPatterns.signup) || includesAny(url, p.urlPatterns.authorize);
    if (onChatgpt && !onAuth) return 'COMPLETED';

    if (includesAny(text, p.pageStateText.errorPage)) return 'ERROR_PAGE';
    if (includesAny(url, p.urlPatterns.aboutYou) || includesAny(text, p.pageStateText.aboutYou)) return 'ABOUT_YOU_READY';
    if (includesAny(url, p.urlPatterns.contactVerification) || includesAny(text, p.pageStateText.smsCode)) {
        return 'SMS_CODE_READY';
    }
    if (hasInputMatching(inputs, (i) => i.type === 'password') || includesAny(text, p.pageStateText.password)) {
        return 'PASSWORD_READY';
    }
    if (hasInputMatching(inputs, (i) => i.name?.toLowerCase().includes('phone') || i.type === 'tel')) {
        return 'PHONE_INPUT_READY';
    }
    return 'IDLE';
}

/**
 * OAuth 流程:从快照推断应触发的事件。
 * 注意 CALLBACK_RECEIVED 通常由浏览器 request 监听产生,不由此函数返回。
 */
export function detectOAuthEvent(snapshot: PageSnapshot, p: PagePatterns, loginMethod: 'phone' | 'email'): OAuthEvent {
    const { url, text, inputs, hasCfChallenge } = snapshot;

    // 最高优先级:浏览器内错误扫描
    if (snapshot.errorType === 'account_deactivated') return 'ACCOUNT_DEACTIVATED';
    if (snapshot.errorType === 'google_sso_redirect') return 'GOOGLE_SSO';
    if (snapshot.errorType === 'rate_limited') return 'RATE_LIMITED';
    if (snapshot.errorType === 'unusual_activity') return 'UNUSUAL_ACTIVITY';

    if (hasCfChallenge) return 'CF_DETECTED';
    if (includesAny(url, p.urlPatterns.googleAccounts)) return 'GOOGLE_SSO';
    if (includesAny(text, p.pageStateText.accountDeactivated)) return 'ACCOUNT_DEACTIVATED';

    if (includesAny(text, p.pageStateText.errorPage)) return 'ERROR_PAGE';

    // 邮箱验证码(优先,绑定/登录都可能进)
    if (includesAny(url, p.urlPatterns.emailVerification) || includesAny(text, p.pageStateText.emailCode)) {
        return 'EMAIL_CODE_READY';
    }
    // 短信验证码
    if (includesAny(url, p.urlPatterns.contactVerification) || includesAny(text, p.pageStateText.smsCode)) {
        return 'SMS_CODE_READY';
    }
    // 绑定邮箱页
    if (includesAny(url, p.urlPatterns.addEmail)) return 'EMAIL_INPUT_READY';
    // about-you
    if (includesAny(url, p.urlPatterns.aboutYou) || includesAny(text, p.pageStateText.aboutYou)) {
        return 'ABOUT_YOU_READY';
    }
    // 授权确认
    if (includesAny(text, p.pageStateText.authorize)) return 'EMAIL_BOUND';
    // 密码
    if (hasInputMatching(inputs, (i) => i.type === 'password') || includesAny(text, p.pageStateText.password)) {
        return 'PASSWORD_READY';
    }
    // 邮箱输入
    if (
        hasInputMatching(
            inputs,
            (i) => i.type === 'email' || ['email', 'username', 'identifier'].includes((i.name ?? '').toLowerCase()),
        )
    ) {
        return 'EMAIL_INPUT_READY';
    }
    // 手机号输入
    if (hasInputMatching(inputs, (i) => i.name?.toLowerCase().includes('phone') || i.type === 'tel')) {
        return 'PHONE_INPUT_READY';
    }
    // 登录方式选择页
    if (includesAny(text, p.pageStateText.loginMethod)) {
        return loginMethod === 'phone' ? 'LOGIN_METHOD_PHONE' : 'LOGIN_METHOD_EMAIL';
    }
    return 'IDLE';
}

/** 复用:非终态状态列表(供转移表 from 字段引用)。 */
export const SIGNUP_NONTERMINAL_STATES = ALL_NONTERMINAL;
