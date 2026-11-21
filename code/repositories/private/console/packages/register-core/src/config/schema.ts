/**
 * 配置 schema:用 zod 定义 AppConfig 的形状与默认值,启动时 fail-fast 校验。
 * 三层合并(default ← 文件 ← 环境变量)后的对象交由这里 parse。
 */
import { z } from 'zod';

export const ProxySchema = z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    username: z.string().optional(),
    password: z.string().optional(),
});

export const AppConfigSchema = z.object({
    sms: z
        .object({
            provider: z.enum(['herosms', 'fivesim']).default('herosms'),
            herosms: z
                .object({
                    apiKey: z.string().default(''),
                    service: z.string().default('dr'),
                    country: z.number().int().default(16),
                })
                .prefault({}),
            fivesim: z
                .object({
                    apiKey: z.string().default(''),
                    country: z.string().default('england'),
                    operator: z.string().default('any'),
                    product: z.string().default('openai'),
                })
                .prefault({}),
        })
        .prefault({}),

    mail: z
        .object({
            provider: z.enum(['legacy', 'yyds', 'imap', 'cdk']).default('legacy'),
            legacy: z
                .object({
                    baseUrl: z.string().default(''),
                    adminPassword: z.string().default(''),
                    sitePassword: z.string().default(''),
                    domain: z.string().default(''),
                })
                .prefault({}),
            yyds: z
                .object({
                    baseUrl: z.string().default('https://mailapi.example.com/v1'),
                    apiKey: z.string().default(''),
                    domain: z.string().default(''),
                    subdomain: z.string().default(''),
                })
                .prefault({}),
            imap: z
                .object({
                    user: z.string().default(''),
                    password: z.string().default(''),
                    host: z.string().default(''),
                    port: z.number().int().min(1).max(65535).default(993),
                    tls: z.boolean().default(true),
                })
                .prefault({}),
            cdk: z
                .object({
                    cdkKey: z.string().default(''),
                    email: z.string().default(''),
                    apiBaseUrl: z.string().default('https://cdk.hhnto.top'),
                })
                .prefault({}),
        })
        .prefault({}),

    browser: z
        .object({
            engine: z.enum(['puppeteer-real', 'playwright']).default('puppeteer-real'),
            headless: z.boolean().default(false),
            viewport: z.object({ width: z.number(), height: z.number() }).default({ width: 1280, height: 900 }),
            lang: z.string().default('zh-CN'),
            executablePath: z.string().optional(),
        })
        .prefault({}),

    oauth: z
        .object({
            clientId: z.string().default('app_EMoamEEZ73f0CkXaXp7hrann'),
            redirectPort: z.number().int().default(1455),
            tokenOutputDirs: z.array(z.string()).default([]),
        })
        .prefault({}),

    proxy: ProxySchema.optional(),

    /** 代理列表(批量代理池,逗号分隔,优先于单一 proxy)。格式: host:port:user:pass,host:port:user:pass */
    proxyList: z.string().default(''),
    proxyStrategy: z.enum(['round-robin', 'random', 'least-used']).default('round-robin'),

    cpa: z
        .object({
            baseUrl: z.string().optional(),
            managementKey: z.string().optional(),
            uploadEnabled: z.boolean().default(false),
        })
        .prefault({}),

    compliance: z
        .object({
            maxAccountsPerHour: z.number().int().positive().default(5),
            minDelayMs: z.number().int().nonnegative().default(60_000),
            requireConfirmation: z.boolean().default(true),
        })
        .prefault({}),

    polling: z
        .object({
            smsIntervalMs: z.number().int().positive().default(5_000),
            smsMaxAttempts: z.number().int().positive().default(20),
            mailIntervalMs: z.number().int().positive().default(5_000),
            mailMaxAttempts: z.number().int().positive().default(10),
            cfTimeoutMs: z.number().int().positive().default(60_000),
        })
        .prefault({}),

    database: z
        .object({
            path: z.string().default('data/app.db'),
        })
        .prefault({}),

    logging: z
        .object({
            level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
            dir: z.string().default('data/logs'),
        })
        .prefault({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
