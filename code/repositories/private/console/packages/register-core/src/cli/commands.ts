/**
 * CLI 子命令实现:register / resume / report。
 * 组装 config → provider → adapter → orchestrator → persistence,接通完整流程。
 * register 内部集成 HealingPolicy 自愈 + ProxyPool 代理轮换。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config/loader.js';
import { openDatabase } from '../persistence/db.js';
import { AccountRepository } from '../persistence/AccountRepository.js';
import { UsernameRepository } from '../persistence/UsernameRepository.js';
import { RunRepository } from '../persistence/RunRepository.js';
import { TokenRepository } from '../persistence/TokenRepository.js';
import { createSmsProvider } from '../providers/sms/createSmsProvider.js';
import { createMailProvider } from '../providers/mail/createMailProvider.js';
import { buildMailBody } from '../providers/mail/mailBodyBuilder.js';
import { extractMailCode } from '../providers/mail/mailCodeParser.js';
import type { BrowserAdapter, BrowserEngine } from '../browser/BrowserAdapter.js';
import { PuppeteerRealAdapter } from '../browser/PuppeteerRealAdapter.js';
import { PlaywrightAdapter } from '../browser/PlaywrightAdapter.js';
import { OAuthClient } from '../oauth/OAuthClient.js';
import { SignupOrchestrator } from '../flows/SignupOrchestrator.js';
import { OAuthOrchestrator } from '../flows/OAuthOrchestrator.js';
import { generateIdentity } from '../flows/IdentityGenerator.js';
import { HealingPolicy } from '../flows/HealingPolicy.js';
import type { HealingDecision } from '../flows/HealingPolicy.js';
import { Guardrails } from '../compliance/guardrails.js';
import { confirmCompliance } from './banner.js';
import { childLogger } from '../logging/logger.js';
import { ProxyPool, parseProxyList } from '../infra/proxyPool.js';
import type { ProxyConfig } from '../infra/proxy.js';
import type { OtpCode } from '../types/brand.js';
import type { PagePatterns } from '../state/pageDetector.js';
import { loadSelectorConfig } from '../config/selectors.js';
import { bundledConfigDir } from '../config/paths.js';
import type { MailProvider } from '../providers/mail/MailProvider.js';
import type { MailMessage } from '../providers/mail/MailProvider.js';
import type { DBType } from '../persistence/db.js';

export interface CommandOptions {
    config?: string;
    confirm?: boolean;
}

/** 每个账号的最大自愈重试次数。 */
const MAX_HEALING_ATTEMPTS = 3;

type RuntimeBrowserAdapter = BrowserAdapter & {
    setProxyPool?: (pool: ProxyPool) => void;
    markProxySuccess?: () => void;
    markProxyFailed?: () => void;
};

function loadPatterns(configDir: string = bundledConfigDir): PagePatterns {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'i18n.json'), 'utf8'));
    return raw as PagePatterns;
}

/** 轮询邮箱验证码(纯逻辑,便于后续单测抽取)。 */
async function pollMailCode(mail: MailProvider, intervalMs: number, maxAttempts: number): Promise<OtpCode> {
    for (let i = 1; i <= maxAttempts; i++) {
        const mails = await mail.getMails(5, 0);
        const latest: MailMessage | undefined = mails[0];
        if (latest) {
            const body = buildMailBody(latest);
            const code = extractMailCode(body, latest.raw ?? '');
            if (code) return code;
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error('邮箱验证码轮询超时');
}

/**
 * 从配置构建代理池(如果配置了 PROXY_LIST)。
 * 返回 { pool, singleProxy }:pool 用于轮换,singleProxy 用于单代理模式(兼容旧配置)。
 */
function buildProxyPool(cfg: ReturnType<typeof loadConfig>): { pool: ProxyPool | null; singleProxy: ProxyConfig | null } {
    if (cfg.proxyList) {
        const proxies = parseProxyList(cfg.proxyList);
        if (proxies.length > 0) {
            return {
                pool: new ProxyPool({ proxies, strategy: cfg.proxyStrategy }),
                singleProxy: null,
            };
        }
    }
    return { pool: null, singleProxy: cfg.proxy ?? null };
}

function createBrowserAdapter(engine: BrowserEngine): RuntimeBrowserAdapter {
    switch (engine) {
        case 'puppeteer-real':
            return new PuppeteerRealAdapter();
        case 'playwright':
            return new PlaywrightAdapter();
        default: {
            const exhaustive: never = engine;
            throw new Error(`未知浏览器引擎: ${exhaustive}`);
        }
    }
}

/**
 * 执行 HealingDecision:retry 返回 true,switchProxy 标记失败并返回 true,
 * 其他动作返回 false(表示不可恢复,应终止当前账号)。
 */
async function applyHealingDecision(
    decision: HealingDecision,
    adapter: RuntimeBrowserAdapter,
    log: ReturnType<typeof childLogger>,
): Promise<boolean> {
    switch (decision.action) {
        case 'retry':
            log.warn({ reason: decision.reason }, '自愈:重试');
            return true;
        case 'switchProxy':
            adapter.markProxyFailed?.();
            log.warn({ reason: decision.reason }, '自愈:切换代理并重试');
            return true;
        case 'changeNumber':
            log.warn({ reason: decision.reason }, '自愈:换号');
            return true;
        case 'giveUp':
            log.error({ reason: decision.reason }, '自愈:放弃');
            return false;
        default:
            log.error({ reason: decision.reason }, '自愈:未识别动作,放弃');
            return false;
    }
}

export async function cmdRegister(count: number, opts: CommandOptions): Promise<void> {
    const cfg = loadConfig({ configPath: opts.config });
    const patterns = loadPatterns();
    const selectors = loadSelectorConfig();

    const requireConfirm = opts.confirm !== false && cfg.compliance.requireConfirmation;
    if (!(await confirmCompliance(requireConfirm))) {
        console.error('未确认合规提示,退出。');
        process.exitCode = 1;
        return;
    }

    const guardrails = new Guardrails(cfg);
    const db: DBType = openDatabase(cfg.database.path);
    const accountRepo = new AccountRepository(db);
    const usernameRepo = new UsernameRepository(db);
    const runRepo = new RunRepository(db);
    const tokenRepo = new TokenRepository(db);
    const { pool: proxyPool, singleProxy } = buildProxyPool(cfg);
    const healing = new HealingPolicy();

    for (let i = 0; i < count; i++) {
        await guardrails.beforeAccount();
        const runId = `run_${crypto.randomUUID()}`;
        const log = childLogger({ runId, mode: 'register' });
        log.info({ index: i + 1, total: count, proxyPoolSize: proxyPool?.size ?? 0 }, '开始注册');

        let succeeded = false;
        let lastError: unknown = null;

        for (let attempt = 1; attempt <= MAX_HEALING_ATTEMPTS && !succeeded; attempt++) {
            const adapter = createBrowserAdapter(cfg.browser.engine);
            if (proxyPool) adapter.setProxyPool?.(proxyPool);

            try {
                const identity = generateIdentity();
                const sms = createSmsProvider(cfg);
                const mail = createMailProvider(cfg);
                const oauth = new OAuthClient(cfg, cfg.proxy ?? null);

                await adapter.launch({
                    headless: cfg.browser.headless,
                    viewport: cfg.browser.viewport,
                    lang: cfg.browser.lang,
                    executablePath: cfg.browser.executablePath,
                    proxy: singleProxy ?? undefined,
                });

                // Phase 1:手机号注册
                const signup = new SignupOrchestrator(adapter, sms, patterns, selectors);
                const signupResult = await signup.run(
                    identity,
                    cfg.sms.herosms.service,
                    cfg.sms.herosms.country,
                    {
                        onSmsCode: () =>
                            sms.pollForCode({
                                intervalMs: cfg.polling.smsIntervalMs,
                                maxAttempts: cfg.polling.smsMaxAttempts,
                            }),
                    },
                );
                const accountId = accountRepo.insert({
                    phone: signupResult.phone,
                    password: identity.password,
                    fullName: identity.fullName,
                    birthDate: identity.birthDate,
                });
                log.info({ phone: signupResult.phone }, 'Phase 1 完成');

                // Phase 2:手机号登录 + 绑定临时邮箱
                const created = await mail.createAddress();
                const oauthOrch = new OAuthOrchestrator(adapter, patterns, selectors);
                oauth.regeneratePkce();
                const phase2 = await oauthOrch.run(
                    oauth.getAuthUrl(),
                    { phone: signupResult.phone, email: created.address, password: identity.password, fullName: identity.fullName },
                    { loginMethod: 'phone', stopAfterEmailBound: true, redirectPort: cfg.oauth.redirectPort },
                    {
                        onSmsCode: () => sms.pollForCode({ intervalMs: cfg.polling.smsIntervalMs, maxAttempts: cfg.polling.smsMaxAttempts }),
                        onEmailCode: () => pollMailCode(mail, cfg.polling.mailIntervalMs, cfg.polling.mailMaxAttempts),
                    },
                );
                const usernameId = usernameRepo.insert({
                    accountId,
                    email: created.address,
                    mailProvider: cfg.mail.provider,
                    mailSession: created.session,
                });
                log.info({ email: created.address, emailBound: phase2.emailBound }, 'Phase 2 完成');

                // Phase 3:邮箱登录 + 换 token
                oauth.regeneratePkce();
                const phase3 = await oauthOrch.run(
                    oauth.getAuthUrl(),
                    { phone: signupResult.phone, email: created.address, password: identity.password, fullName: identity.fullName },
                    { loginMethod: 'email', redirectPort: cfg.oauth.redirectPort },
                    {
                        onSmsCode: () => sms.pollForCode({ intervalMs: cfg.polling.smsIntervalMs, maxAttempts: cfg.polling.smsMaxAttempts }),
                        onEmailCode: () => pollMailCode(mail, cfg.polling.mailIntervalMs, cfg.polling.mailMaxAttempts),
                    },
                );
                if (!phase3.callbackUrl) throw new Error('Phase 3 未捕获 OAuth 回调');
                const params = oauth.extractCallbackParams(phase3.callbackUrl);
                if (!params?.code) throw new Error(`OAuth 授权失败: ${params?.error ?? '无 code'}`);
                const { token } = await oauth.exchangeTokenAndSave(params.code, created.address);
                // 事务保护:先写数据库(可回滚),再写文件(不可回滚但可事后清理)
                // ponytail: node:sqlite 无 .transaction() 助手,手写 BEGIN/COMMIT/ROLLBACK
                db.exec('BEGIN;');
                try {
                    tokenRepo.insert({
                        usernameId,
                        email: created.address,
                        accountId: token.account_id,
                        accessToken: token.access_token,
                        refreshToken: token.refresh_token,
                        idToken: token.id_token,
                        expiredAt: token.expired,
                        savedFilePaths: [], // 文件尚未写入,事务成功后补填
                    });
                    accountRepo.markOauthDone(signupResult.phone);
                    db.exec('COMMIT;');
                } catch (txErr) {
                    db.exec('ROLLBACK;');
                    throw txErr;
                }
                // 数据库事务成功后才写文件,避免孤儿 token 文件
                const savedPaths = oauth.saveTokenFiles(token, created.address);
                runRepo.finish(runId, 'success', { phasesReached: ['phase1', 'phase2', 'phase3'] });
                log.info({ email: created.address, savedPaths }, 'Phase 3 完成,token 已保存');

                // 标记代理成功(如果用了代理池)
                adapter.markProxySuccess?.();
                succeeded = true;
            } catch (e) {
                lastError = e;
                const decision = healing.decide(e, { attempt, maxAttempts: MAX_HEALING_ATTEMPTS, phase: 'register' });
                const recoverable = await applyHealingDecision(decision, adapter, log);
                if (!recoverable) {
                    runRepo.finish(runId, 'failed', { errorMessage: decision.reason });
                    break;
                }
            } finally {
                await adapter.close();
            }
        }

        if (!succeeded) {
            const msg = String((lastError as Error)?.message ?? lastError ?? '未知错误');
            log.error({ err: lastError }, '注册失败(所有自愈策略耗尽)');
            // 如果 runRepo.finish 还没被调用(比如 applyHealingDecision 返回 false 时已调用)
            // 做个兜底
            try { runRepo.finish(runId, 'failed', { errorMessage: msg }); } catch { /* already finished */ }
        }
    }
    db.close();
}

export async function cmdResume(_opts: CommandOptions): Promise<void> {
    // TODO: 对应 phase8 —— 遍历 username.json 表,用已绑定邮箱的 session 复用 + 邮箱 OTP 重新换 token。
    // 组件已就绪(UsernameRepository.findAll / useExistingAddressSession / OAuthOrchestrator loginMethod=email),
    // 此处留作增量示范。
    console.error('resume(对应 phase8)尚未实现:组件已就绪,待接通遍历 + 邮箱 OTP 流程。');
    process.exitCode = 1;
}

export async function cmdReport(runId: string | undefined, opts: CommandOptions): Promise<void> {
    const cfg = loadConfig({ configPath: opts.config });
    const db = openDatabase(cfg.database.path);
    const runRepo = new RunRepository(db);
    if (runId) {
        const row = runRepo.findByRunId(runId);
        if (!row) {
            console.error(`未找到 runId=${runId}`);
            process.exitCode = 1;
            db.close();
            return;
        }
        console.log(JSON.stringify(row.report ?? row, null, 2));
    } else {
        const rows = runRepo.recent(20);
        for (const r of rows) {
            console.log(`${r.runId}  ${r.status}  ${r.mode}  ${r.startedAt}  ${r.errorMessage ?? ''}`);
        }
    }
    db.close();
}
