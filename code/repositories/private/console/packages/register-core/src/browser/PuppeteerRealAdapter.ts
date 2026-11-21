/**
 * puppeteer-real-browser 适配器(主实现)。
 * 迁移现有 browserService.js 的 IO 能力,收敛为 BrowserAdapter 接口。
 * 资源管理:每次启动用独立 userDataDir,close 时 SIGTERM→close→SIGKILL 三段式清理 + 删目录。
 *
 * 注意:puppeteer-real-browser 的 connect 返回类型较宽松,此处对 browser/page 用宽松类型,
 * 核心逻辑(状态机决策)不在此文件,故类型风险不影响业务正确性。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from 'puppeteer-real-browser';
import type { PageSnapshot } from '../state/states.js';
import type {
    BrowserAdapter,
    BrowserEngine,
    BrowserLaunchOptions,
    ClickByTextOptions,
    GotoOptions,
    TypeOptions,
} from './BrowserAdapter.js';
import { CloudflareGuard } from './CloudflareGuard.js';
import { findClickTargetFn, setReactInputFn, snapshotFn, type ClickTargetProbeResult } from './DomKit.js';
import { randomizeFingerprint } from './Fingerprint.js';
import type { FingerprintProfile } from './Fingerprint.js';
import type { ProxyPool } from '../infra/proxyPool.js';

export class PuppeteerRealAdapter implements BrowserAdapter {
    readonly engine: BrowserEngine = 'puppeteer-real';

    private browser: any = null;
    private page: any = null;
    private userDataDir: string | null = null;
    /** 当前注册会话的指纹配置(每次 launch 随机生成)。 */
    private currentFingerprint: FingerprintProfile | null = null;
    /** 当前使用的代理(用于 markFailed/markSuccess)。 */
    private currentProxy: { host: string; port: number } | null = null;
    /** 可选的代理池,优先于 opts.proxy 单一代理。 */
    private proxyPool: ProxyPool | null = null;

    /** 设置代理池(批量注册时每个账号轮换 IP)。 */
    setProxyPool(pool: ProxyPool): void {
        this.proxyPool = pool;
    }

    async launch(opts: BrowserLaunchOptions): Promise<void> {
        this.userDataDir = opts.userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'reg-chrome-'));
        const fp = randomizeFingerprint();
        this.currentFingerprint = fp;

        // Chrome 启动参数:注入指纹特征
        const args = [
            '--no-sandbox',
            '--disable-gpu',
            `--lang=${opts.lang ?? fp.lang}`,
            `--user-data-dir=${this.userDataDir}`,
            `--window-size=${opts.viewport?.width ?? fp.viewport.width},${opts.viewport?.height ?? fp.viewport.height}`,
        ];

        const connectOpts: Record<string, unknown> = {
            headless: opts.headless ?? false,
            turnstile: true,
            args,
            // 视口:优先使用 opts,否则使用指纹池中的随机值
            viewport: opts.viewport ?? fp.viewport,
        };
        if (opts.executablePath) {
            connectOpts.customConfig = { chromePath: opts.executablePath };
        }
        if (opts.proxy) {
            const p = opts.proxy;
            this.currentProxy = { host: p.host, port: p.port };
            connectOpts.proxy = {
                server: `${p.host}:${p.port}`,
                username: p.username,
                password: p.password,
            };
        } else if (this.proxyPool && this.proxyPool.healthy() > 0) {
            const p = this.proxyPool.acquire();
            this.currentProxy = { host: p.host, port: p.port };
            connectOpts.proxy = {
                server: `${p.host}:${p.port}`,
                username: p.username,
                password: p.password,
            };
        }
        const result = (await connect(connectOpts as any)) as { browser: any; page: any };
        this.browser = result.browser;
        this.page = result.page;

        // 注入指纹:时区 + deviceMemory + hardwareConcurrency(在新页面加载前)
        if (this.currentFingerprint) {
            const tz = this.currentFingerprint.timezone;
            const mem = this.currentFingerprint.deviceMemory;
            const cores = this.currentFingerprint.hardwareConcurrency;
            await this.page.evaluateOnNewDocument((t: string, m: number, c: number) => {
                // 覆盖时区(Intl.DateTimeFormat 更底层,比 Date.getTimezoneOffset 更难检测)
                const origDateTimeFormat = Intl.DateTimeFormat;
                // @ts-expect-error 注入函数不引用外部作用域,类型由调用方保证
                Intl.DateTimeFormat = function (locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
                    const opts = { ...(options ?? {}) };
                    opts.timeZone = t;
                    return new origDateTimeFormat(locales, opts);
                };
                // 覆盖 deviceMemory 和 hardwareConcurrency
                Object.defineProperty(navigator, 'deviceMemory', { get: () => m, configurable: true });
                Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => c, configurable: true });
            }, tz, mem, cores);
        }
    }

    async close(): Promise<void> {
        try {
            this.browser?.process()?.kill('SIGTERM');
        } catch {
            /* ignore */
        }
        await new Promise((r) => setTimeout(r, 1000));
        try {
            await Promise.race([
                this.browser?.close(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('close timeout')), 8_000)),
            ]);
        } catch {
            /* ignore */
        }
        try {
            this.browser?.process()?.kill('SIGKILL');
        } catch {
            /* ignore */
        }
        if (this.userDataDir) {
            await new Promise((r) => setTimeout(r, 500));
            try {
                fs.rmSync(this.userDataDir, { recursive: true, force: true });
            } catch {
                /* ignore */
            }
        }
        this.browser = null;
        this.page = null;
    }

    async goto(url: string, opts?: GotoOptions): Promise<void> {
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts?.timeoutMs ?? 60_000 });
        if (opts?.waitForCf) {
            await new CloudflareGuard(this).wait(opts?.timeoutMs ?? 60_000);
        }
    }

    async waitForCloudflare(timeoutMs?: number): Promise<void> {
        await new CloudflareGuard(this).wait(timeoutMs ?? 60_000);
    }

    async snapshot(): Promise<PageSnapshot> {
        const result = await this.page.evaluate(snapshotFn);
        return result as PageSnapshot;
    }

    async evaluate<T>(fn: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T> {
        return (await this.page.evaluate(fn, ...args)) as T;
    }

    async clickButtonByText(text: string, opts?: ClickByTextOptions): Promise<void> {
        const deadline = Date.now() + (opts?.timeoutMs ?? 10_000);
        // 用 const probe 接收每次探测结果,让 TS 能对 discriminated union 正确收窄;
        // failedProbe 仅保留最后一次失败结果供循环外诊断。
        let failedProbe: ClickTargetProbeResult | null = null;

        while (Date.now() <= deadline) {
            const probe = await this.page.evaluate(findClickTargetFn, {
                text,
                exact: opts?.exact,
                selector: opts?.selector,
            });
            if (probe.ok) {
                // CDP 级真实鼠标点击:产生完整 pointerdown→mousedown→pointerup→mouseup→click 链条。
                await this.page.mouse.move(probe.x, probe.y, { steps: 8 });
                await this.page.mouse.down();
                await new Promise((r) => setTimeout(r, 60));
                await this.page.mouse.up();
                return;
            }
            failedProbe = probe;
            if (probe.reason === 'disabled' || probe.reason === 'covered') break;
            await new Promise((r) => setTimeout(r, 250));
        }

        const name = opts?.debugName ?? text;
        const suffix = failedProbe && !failedProbe.ok
            ? `reason=${failedProbe.reason}; detail=${failedProbe.detail}; candidates=${failedProbe.candidates.join(' | ')}`
            : 'reason=probe_not_run';
        throw new Error(`clickButtonByText(${name}) 失败: ${suffix}`);
    }

    async setInputValue(selector: string, value: string, opts?: TypeOptions): Promise<void> {
        await this.page.waitForSelector(selector, { timeout: opts?.timeoutMs ?? 30_000 });
        const handle = await this.page.$(selector);
        if (!handle) throw new Error(`setInputValue: 未找到选择器 ${selector}`);
        await this.page.evaluate(setReactInputFn, handle, value);
    }

    async type(selector: string, text: string, opts?: TypeOptions): Promise<void> {
        if (opts?.clearFirst) {
            await this.page.click(selector, { clickCount: 3 });
        }
        await this.page.type(selector, text, { delay: opts?.delayMs ?? 50 });
    }

    async waitForSelector(selector: string, timeoutMs?: number): Promise<void> {
        await this.page.waitForSelector(selector, { timeout: timeoutMs ?? 30_000 });
    }

    onRequestUrlMatch(
        matcher: (url: URL) => boolean,
        handler: (url: URL) => void,
    ): () => void {
        const listener = (req: { url: () => string }) => {
            try {
                const u = new URL(req.url());
                if (matcher(u)) handler(u);
            } catch {
                /* 非 http(s) 请求忽略 */
            }
        };
        this.page.on('request', listener);
        return () => {
            this.page.off('request', listener);
        };
    }

    async screenshot(filename: string): Promise<string> {
        const dir = path.join(os.tmpdir(), 'reg-screenshots');
        fs.mkdirSync(dir, { recursive: true });
        const fp = path.join(dir, filename);
        await this.page.screenshot({ path: fp });
        return fp;
    }

    url(): string {
        return this.page?.url() ?? '';
    }

    /** 标记当前代理成功(重置失败计数)。 */
    markProxySuccess(): void {
        if (this.currentProxy && this.proxyPool) {
            this.proxyPool.markSuccess(this.currentProxy);
        }
    }

    /** 标记当前代理失败(累计失败次数,超阈值自动踢出)。 */
    markProxyFailed(): void {
        if (this.currentProxy && this.proxyPool) {
            this.proxyPool.markFailed(this.currentProxy);
        }
    }
}
