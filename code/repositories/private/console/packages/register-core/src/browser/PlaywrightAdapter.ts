/**
 * Playwright 适配器。
 * 与 PuppeteerRealAdapter 共用 BrowserAdapter 契约和 DomKit 页面探针,用于本地调试与第二引擎回归。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { PageSnapshot } from '../state/states.js';
import type {
    BrowserAdapter,
    BrowserEngine,
    BrowserLaunchOptions,
    ClickByTextOptions,
    GotoOptions,
    TypeOptions,
} from './BrowserAdapter.js';
import { findClickTargetFn, setReactInputFn, snapshotFn } from './DomKit.js';
import { CloudflareGuard } from './CloudflareGuard.js';
import { randomizeFingerprint } from './Fingerprint.js';
import type { ProxyPool } from '../infra/proxyPool.js';

function proxyServer(host: string, port: number): string {
    return /^https?:\/\//i.test(host) || /^socks[45]?:\/\//i.test(host) ? `${host}:${port}` : `http://${host}:${port}`;
}

export class PlaywrightAdapter implements BrowserAdapter {
    readonly engine: BrowserEngine = 'playwright';

    private context: BrowserContext | null = null;
    private page: Page | null = null;
    private userDataDir: string | null = null;
    private currentProxy: { host: string; port: number } | null = null;
    private proxyPool: ProxyPool | null = null;

    setProxyPool(pool: ProxyPool): void {
        this.proxyPool = pool;
    }

    async launch(opts: BrowserLaunchOptions): Promise<void> {
        this.userDataDir = opts.userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'reg-pw-'));
        const fp = randomizeFingerprint();

        const proxy = opts.proxy ?? (this.proxyPool && this.proxyPool.healthy() > 0 ? this.proxyPool.acquire() : undefined);
        if (proxy) this.currentProxy = { host: proxy.host, port: proxy.port };

        this.context = await chromium.launchPersistentContext(this.userDataDir, {
            headless: opts.headless ?? false,
            executablePath: opts.executablePath,
            viewport: opts.viewport ?? fp.viewport,
            locale: opts.lang ?? fp.lang,
            args: [
                '--no-sandbox',
                '--disable-gpu',
                `--lang=${opts.lang ?? fp.lang}`,
                `--window-size=${opts.viewport?.width ?? fp.viewport.width},${opts.viewport?.height ?? fp.viewport.height}`,
            ],
            proxy: proxy
                ? {
                      server: proxyServer(proxy.host, proxy.port),
                      username: proxy.username,
                      password: proxy.password,
                  }
                : undefined,
        });

        const tz = fp.timezone;
        const mem = fp.deviceMemory;
        const cores = fp.hardwareConcurrency;
        await this.context.addInitScript(
            ({ timezone, deviceMemory, hardwareConcurrency }) => {
                const OriginalDateTimeFormat = Intl.DateTimeFormat;
                // @ts-expect-error 页面注入中重载 DateTimeFormat,由浏览器上下文执行。
                Intl.DateTimeFormat = function (locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
                    const opts = { ...(options ?? {}), timeZone: timezone };
                    return new OriginalDateTimeFormat(locales, opts);
                };
                Object.defineProperty(navigator, 'deviceMemory', { get: () => deviceMemory, configurable: true });
                Object.defineProperty(navigator, 'hardwareConcurrency', {
                    get: () => hardwareConcurrency,
                    configurable: true,
                });
            },
            { timezone: tz, deviceMemory: mem, hardwareConcurrency: cores },
        );

        this.page = this.context.pages()[0] ?? (await this.context.newPage());
    }

    async close(): Promise<void> {
        try {
            await this.context?.close();
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
        this.context = null;
        this.page = null;
    }

    async goto(url: string, opts?: GotoOptions): Promise<void> {
        await this.requirePage().goto(url, { waitUntil: 'domcontentloaded', timeout: opts?.timeoutMs ?? 60_000 });
        if (opts?.waitForCf) await new CloudflareGuard(this).wait(opts.timeoutMs ?? 60_000);
    }

    async waitForCloudflare(timeoutMs?: number): Promise<void> {
        await new CloudflareGuard(this).wait(timeoutMs ?? 60_000);
    }

    async snapshot(): Promise<PageSnapshot> {
        return await this.requirePage().evaluate(snapshotFn);
    }

    async evaluate<T>(fn: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T> {
        if (typeof fn === 'string') {
            return await this.requirePage().evaluate(
                ({ source, values }) => {
                    const callable = (0, eval)(source) as (...innerArgs: unknown[]) => unknown;
                    return callable(...values);
                },
                { source: fn, values: args },
            ) as T;
        }
        return await this.requirePage().evaluate(
            ({ source, values }) => {
                const callable = (0, eval)(`(${source})`) as (...innerArgs: unknown[]) => unknown;
                return callable(...values);
            },
            { source: fn.toString(), values: args },
        ) as T;
    }

    async clickButtonByText(text: string, opts?: ClickByTextOptions): Promise<void> {
        const page = this.requirePage();
        const deadline = Date.now() + (opts?.timeoutMs ?? 10_000);
        let lastProbe: Awaited<ReturnType<typeof findClickTargetFn>> | null = null;

        while (Date.now() <= deadline) {
            lastProbe = await page.evaluate(findClickTargetFn, {
                text,
                exact: opts?.exact,
                selector: opts?.selector,
            });
            if (lastProbe.ok) {
                await page.mouse.move(lastProbe.x, lastProbe.y, { steps: 8 });
                await page.mouse.down();
                await new Promise((r) => setTimeout(r, 60));
                await page.mouse.up();
                return;
            }
            if (lastProbe.reason === 'disabled' || lastProbe.reason === 'covered') break;
            await new Promise((r) => setTimeout(r, 250));
        }

        const name = opts?.debugName ?? text;
        const suffix = lastProbe
            ? `reason=${lastProbe.reason}; detail=${lastProbe.detail}; candidates=${lastProbe.candidates.join(' | ')}`
            : 'reason=probe_not_run';
        throw new Error(`clickButtonByText(${name}) 失败: ${suffix}`);
    }

    async setInputValue(selector: string, value: string, opts?: TypeOptions): Promise<void> {
        const locator = this.requirePage().locator(selector).first();
        await locator.waitFor({ state: 'visible', timeout: opts?.timeoutMs ?? 30_000 });
        await locator.evaluate(setReactInputFn, value);
    }

    async type(selector: string, text: string, opts?: TypeOptions): Promise<void> {
        const locator = this.requirePage().locator(selector).first();
        await locator.waitFor({ state: 'visible', timeout: opts?.timeoutMs ?? 30_000 });
        if (opts?.clearFirst) await locator.selectText();
        await locator.type(text, { delay: opts?.delayMs ?? 50 });
    }

    async waitForSelector(selector: string, timeoutMs?: number): Promise<void> {
        await this.requirePage().locator(selector).first().waitFor({ state: 'visible', timeout: timeoutMs ?? 30_000 });
    }

    onRequestUrlMatch(matcher: (url: URL) => boolean, handler: (url: URL) => void): () => void {
        const listener = (request: { url: () => string }) => {
            try {
                const u = new URL(request.url());
                if (matcher(u)) handler(u);
            } catch {
                /* 非 http(s) 请求忽略 */
            }
        };
        this.requirePage().on('request', listener);
        return () => this.page?.off('request', listener);
    }

    async screenshot(filename: string): Promise<string> {
        const dir = path.join(os.tmpdir(), 'reg-screenshots');
        fs.mkdirSync(dir, { recursive: true });
        const fp = path.join(dir, filename);
        await this.requirePage().screenshot({ path: fp });
        return fp;
    }

    url(): string {
        return this.page?.url() ?? '';
    }

    markProxySuccess(): void {
        if (this.currentProxy && this.proxyPool) this.proxyPool.markSuccess(this.currentProxy);
    }

    markProxyFailed(): void {
        if (this.currentProxy && this.proxyPool) this.proxyPool.markFailed(this.currentProxy);
    }

    private requirePage(): Page {
        if (!this.page) throw new Error('PlaywrightAdapter: page 尚未初始化');
        return this.page;
    }
}
