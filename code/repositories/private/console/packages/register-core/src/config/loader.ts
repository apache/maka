/**
 * 配置加载器:三层合并 + 环境变量映射 + 业务规则校验。
 * 优先级:schema 默认值 < 用户 config 文件 < 环境变量。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { AppConfigSchema, type AppConfig } from './schema.js';

export class ConfigValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConfigValidationError';
    }
}

export interface LoadOptions {
    /** 用户 config 文件路径(默认 cwd/config.json)。 */
    configPath?: string;
    /** 注入的环境变量(测试用);提供时跳过读取 .env。 */
    env?: NodeJS.ProcessEnv;
    cwd?: string;
}

/** 深合并两个普通对象(数组整体替换)。 */
export function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
        if (value === undefined) continue;
        if (isPlainObject(value) && isPlainObject(out[key])) {
            out[key] = deepMerge(out[key] as Record<string, unknown>, value);
        } else {
            out[key] = value;
        }
    }
    return out as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseBool(v: string | undefined, fallback: boolean): boolean {
    if (v === undefined || v === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function parseNum(v: string | undefined, fallback: number): number {
    if (v === undefined || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * 把扁平的环境变量映射到嵌套的 AppConfig 形状。
 * 纯函数,便于单测。
 */
export function envToConfig(env: NodeJS.ProcessEnv): Record<string, unknown> {
    const cfg: Record<string, unknown> = {};

    const set = (keyPath: readonly string[], val: unknown): void => {
        if (val === undefined || val === '') return;
        let node = cfg;
        for (let i = 0; i < keyPath.length - 1; i++) {
            const k = keyPath[i]!;
            node[k] = (node[k] as Record<string, unknown>) ?? {};
            node = node[k] as Record<string, unknown>;
        }
        node[keyPath[keyPath.length - 1]!] = val;
    };

    // SMS
    set(['sms', 'provider'], env.REG_SMS_PROVIDER);
    set(['sms', 'herosms', 'apiKey'], env.HERO_SMS_API_KEY);
    set(['sms', 'herosms', 'service'], env.HERO_SMS_SERVICE);
    set(['sms', 'herosms', 'country'], parseNum(env.HERO_SMS_COUNTRY, 16));
    set(['sms', 'fivesim', 'apiKey'], env.FIVE_SIM_API_KEY);
    set(['sms', 'fivesim', 'country'], env.FIVE_SIM_COUNTRY);
    set(['sms', 'fivesim', 'operator'], env.FIVE_SIM_OPERATOR);
    set(['sms', 'fivesim', 'product'], env.FIVE_SIM_PRODUCT);

    // Mail
    set(['mail', 'provider'], env.REG_MAIL_PROVIDER);
    set(['mail', 'legacy', 'baseUrl'], env.MAIL_BASE_URL);
    set(['mail', 'legacy', 'adminPassword'], env.MAIL_ADMIN_PASSWORD);
    set(['mail', 'legacy', 'sitePassword'], env.MAIL_SITE_PASSWORD);
    set(['mail', 'legacy', 'domain'], env.MAIL_DOMAIN);
    set(['mail', 'yyds', 'baseUrl'], env.YYDS_MAIL_BASE_URL);
    set(['mail', 'yyds', 'apiKey'], env.YYDS_MAIL_API_KEY);
    set(['mail', 'yyds', 'domain'], env.YYDS_MAIL_DOMAIN);
    set(['mail', 'yyds', 'subdomain'], env.YYDS_MAIL_SUBDOMAIN);

    // IMAP (external email)
    set(['mail', 'imap', 'user'], env.IMAP_USER);
    set(['mail', 'imap', 'password'], env.IMAP_PASSWORD);
    set(['mail', 'imap', 'host'], env.IMAP_HOST);
    set(['mail', 'imap', 'port'], parseNum(env.IMAP_PORT, 993));
    set(['mail', 'imap', 'tls'], parseBool(env.IMAP_TLS, true));

    // CDK API(CDK 兑换的 Outlook 邮箱)
    set(['mail', 'cdk', 'cdkKey'], env.CDK_KEY);
    set(['mail', 'cdk', 'email'], env.CDK_EMAIL);
    set(['mail', 'cdk', 'apiBaseUrl'], env.CDK_API_BASE_URL);

    // Browser
    set(['browser', 'engine'], env.BROWSER_ENGINE);
    set(['browser', 'headless'], parseBool(env.BROWSER_HEADLESS, false));
    set(['browser', 'lang'], env.BROWSER_LANG);
    set(['browser', 'executablePath'], env.BROWSER_EXECUTABLE_PATH);

    // OAuth
    set(['oauth', 'clientId'], env.OAUTH_CLIENT_ID);
    set(['oauth', 'redirectPort'], parseNum(env.OAUTH_REDIRECT_PORT, 1455));
    if (env.TOKEN_OUTPUT_DIRS) {
        set(['oauth', 'tokenOutputDirs'], env.TOKEN_OUTPUT_DIRS.split(/[;,:]/).filter(Boolean));
    }

    // Proxy
    if (env.PROXY_HOST) {
        set(['proxy', 'host'], env.PROXY_HOST);
        set(['proxy', 'port'], parseNum(env.PROXY_PORT, 0));
        set(['proxy', 'username'], env.PROXY_USERNAME);
        set(['proxy', 'password'], env.PROXY_PASSWORD);
    }
    set(['proxyList'], env.PROXY_LIST);
    set(['proxyStrategy'], env.PROXY_STRATEGY);

    // CPA
    set(['cpa', 'baseUrl'], env.CPA_BASE_URL);
    set(['cpa', 'managementKey'], env.CPA_MANAGEMENT_KEY);
    set(['cpa', 'uploadEnabled'], parseBool(env.CPA_UPLOAD_ENABLED, false));

    // Compliance
    set(['compliance', 'maxAccountsPerHour'], parseNum(env.COMPLIANCE_MAX_ACCOUNTS_PER_HOUR, 5));
    set(['compliance', 'minDelayMs'], parseNum(env.COMPLIANCE_MIN_DELAY_MS, 60_000));
    set(['compliance', 'requireConfirmation'], parseBool(env.COMPLIANCE_REQUIRE_CONFIRMATION, true));

    // DB / logging
    set(['database', 'path'], env.DB_PATH);
    set(['logging', 'level'], env.LOG_LEVEL);
    set(['logging', 'dir'], env.LOG_DIR);

    return cfg;
}

/**
 * 跨字段业务规则校验:所选渠道的必要凭据必须齐全。
 * 失败抛 ConfigValidationError(由 CLI 捕获并以退出码 2 终止)。
 */
export function validateBusinessRules(cfg: AppConfig): void {
    if (cfg.sms.provider === 'herosms' && !cfg.sms.herosms.apiKey) {
        throw new ConfigValidationError('sms.provider=herosms 但未配置 HERO_SMS_API_KEY');
    }
    if (cfg.sms.provider === 'fivesim') {
        if (!cfg.sms.fivesim.apiKey) throw new ConfigValidationError('sms.provider=fivesim 但未配置 FIVE_SIM_API_KEY');
        if (!cfg.sms.fivesim.product) throw new ConfigValidationError('sms.provider=fivesim 但未配置 FIVE_SIM_PRODUCT');
    }
    if (cfg.mail.provider === 'legacy') {
        const { baseUrl, adminPassword, domain } = cfg.mail.legacy;
        if (!baseUrl || !adminPassword || !domain) {
            throw new ConfigValidationError('mail.provider=legacy 需配置 MAIL_BASE_URL / MAIL_ADMIN_PASSWORD / MAIL_DOMAIN');
        }
    }
    if (cfg.mail.provider === 'yyds' && !cfg.mail.yyds.apiKey) {
        throw new ConfigValidationError('mail.provider=yyds 但未配置 YYDS_MAIL_API_KEY');
    }
    if (cfg.mail.provider === 'imap') {
        const { user, password } = cfg.mail.imap;
        if (!user || !password) {
            throw new ConfigValidationError(
                'mail.provider=imap 需配置 IMAP_USER / IMAP_PASSWORD (Gmail 需应用专用密码; QQ/163 需授权码)',
            );
        }
    }
    if (cfg.mail.provider === 'cdk') {
        const { cdkKey, email } = cfg.mail.cdk;
        if (!cdkKey || !email) {
            throw new ConfigValidationError('mail.provider=cdk 需配置 CDK_KEY / CDK_EMAIL');
        }
    }
}

/** 读取用户 config 文件(JSON);不存在返回空对象,解析失败抛错。 */
function readUserConfig(cfgPath: string): Record<string, unknown> {
    if (!fs.existsSync(cfgPath)) return {};
    const raw = fs.readFileSync(cfgPath, 'utf8');
    try {
        const parsed = JSON.parse(raw);
        return isPlainObject(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch (e) {
        throw new ConfigValidationError(`config 文件 JSON 解析失败(${cfgPath}): ${(e as Error).message}`);
    }
}

/**
 * 加载并校验配置。生产环境会读取 .env;测试可通过 opts.env 注入。
 */
export function loadConfig(opts: LoadOptions = {}): AppConfig {
    const injected = !!opts.env;
    const env = opts.env ?? process.env;
    const cwd = opts.cwd ?? process.cwd();

    if (!injected) {
        const dotenvPath = path.join(cwd, '.env');
        if (fs.existsSync(dotenvPath)) {
            loadDotenv({ path: dotenvPath });
        }
    }

    const fileConfig = readUserConfig(opts.configPath ?? path.join(cwd, 'config.json'));
    const envConfig = envToConfig(env);
    const merged = deepMerge(fileConfig, envConfig);

    const parsed = AppConfigSchema.parse(merged);
    validateBusinessRules(parsed);
    return parsed;
}
