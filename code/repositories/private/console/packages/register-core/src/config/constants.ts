/**
 * 全局命名常量:集中所有"魔法数字",替代 demo 里散落各处的裸数字。
 * 改超时/轮询/重试参数只改这里(或经 config 覆盖)。
 */

export const Timing = {
    SMS_POLL_INTERVAL_MS: 5_000,
    SMS_POLL_MAX_ATTEMPTS: 20,
    MAIL_POLL_INTERVAL_MS: 5_000,
    MAIL_POLL_MAX_ATTEMPTS: 10,
    CLOUDFLARE_TIMEOUT_MS: 60_000,
    PAGE_ROUND_INTERVAL_MS: 3_000,
    SIGNUP_MAX_ROUNDS: 20,
    OAUTH_MAX_ROUNDS: 30,
    BROWSER_CLOSE_TIMEOUT_MS: 8_000,
    BROWSER_EVALUATE_TIMEOUT_MS: 8_000,
    OAUTH_TOKEN_TIMEOUT_MS: 30_000,
    GET_NUMBER_RETRY_DELAY_MS: 5_000,
    GET_NUMBER_MAX_RETRIES: 5,
    PHASE_FAILURE_RETRY_DELAY_MS: 20_000,
    MAIL_BIND_MAX_RETRIES: 3,
} as const;

export const OAuth = {
    AUTH_BASE: 'https://auth.openai.com',
    DEFAULT_CLIENT_ID: 'app_EMoamEEZ73f0CkXaXp7hrann',
    DEFAULT_REDIRECT_PORT: 1455,
    REDIRECT_PATH: '/auth/callback',
    SCOPE: 'openid email profile offline_access',
} as const;

export const Compliance = {
    DEFAULT_MAX_PER_HOUR: 5,
    DEFAULT_MIN_DELAY_MS: 60_000,
    WINDOW_HOUR_MS: 3_600_000,
} as const;

export const Defaults = {
    BROWSER_LANG: 'zh-CN',
    TOKEN_DIR: 'tokens',
    DB_PATH: 'data/app.db',
    LOG_DIR: 'data/logs',
} as const;
