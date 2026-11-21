/**
 * 状态机相关类型:页面快照(PageSnapshot)+ 注册/OAuth 流程的命名状态枚举。
 * PageSnapshot 是 evaluate 从浏览器抓回的原始数据,是状态机唯一的"外部输入"。
 */

/**
 * 快照级错误类型:在浏览器内(全量文本未截断前)扫描到的语义错误,
 * 供 pageDetector 优先使用,避免错误文本被截断后丢失。
 */
export type SnapshotErrorType =
    | 'phone_registered'
    | 'account_deactivated'
    | 'google_sso_redirect'
    | 'password_incorrect'
    | 'rate_limited'
    | 'unusual_activity'
    | null;

/** 一次 evaluate 抓取的页面原始快照(状态机的输入,不可变)。 */
export interface PageSnapshot {
    readonly url: string;
    readonly title: string;
    /** body.innerText(已截断至 8000 字符)。 */
    readonly text: string;
    readonly inputs: ReadonlyArray<{
        readonly type: string;
        readonly name?: string;
        readonly placeholder?: string;
        readonly id?: string;
        readonly visible: boolean;
    }>;
    readonly buttonLabels: readonly string[];
    readonly hasCfChallenge: boolean;
    /** 浏览器内错误扫描结果(在文本截断前完成,不依赖 URL 匹配)。 */
    readonly errorType: SnapshotErrorType;
    /** 匹配到的错误上下文(原始文本片段,最多 200 字符)。 */
    readonly errorContext: string;
    readonly capturedAt: number;
}

/** 注册流程(ChatGPT 手机号注册)的命名状态。 */
export type SignupState =
    | 'Idle'
    | 'NavigatingSignup'
    | 'CloudflarePending'
    | 'PhoneEntry'
    | 'PasswordEntry'
    | 'SmsCodeEntry'
    | 'AboutYou'
    | 'ErrorPage'
    | 'GoogleSsoHijack'
    | 'PhoneAlreadyRegistered'
    | 'AccountDeactivated'
    | 'Completed'
    | 'Failed';

/** OAuth 流程(Codex 授权)的命名状态。 */
export type OAuthState =
    | 'Idle'
    | 'NavigatingAuth'
    | 'CloudflarePending'
    | 'LoginMethodSelect'
    | 'PhoneLogin'
    | 'EmailLogin'
    | 'PasswordEntry'
    | 'SmsCodeEntry'
    | 'EmailCodeEntry'
    | 'AboutYou'
    | 'EmailBindRequired'
    | 'AuthorizeConsent'
    | 'ErrorPage'
    | 'GoogleSsoHijack'
    | 'AccountDeactivated'
    | 'CallbackReceived'
    | 'Failed';

/** 致命终态集合(到达即停止,上层需换号/换策略)。 */
export const SIGNUP_TERMINAL_STATES: ReadonlySet<SignupState> = new Set([
    'Completed',
    'Failed',
    'PhoneAlreadyRegistered',
    'AccountDeactivated',
    'GoogleSsoHijack',
]);

export const OAUTH_TERMINAL_STATES: ReadonlySet<OAuthState> = new Set([
    'CallbackReceived',
    'Failed',
    'AccountDeactivated',
    'GoogleSsoHijack',
]);
