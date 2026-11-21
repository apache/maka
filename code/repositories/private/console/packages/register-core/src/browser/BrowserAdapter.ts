/**
 * 浏览器适配器抽象接口。
 * 把现有 browserService.js 2280 行上帝类的所有 IO 能力收敛为这一组方法,
 * 使上层(SignupOrchestrator/OAuthOrchestrator)只依赖接口,不依赖具体引擎。
 * 实现:PuppeteerRealAdapter(主)/ PlaywrightAdapter(预留)/ MockBrowserAdapter(测试)。
 */
import type { PageSnapshot } from '../state/states.js';

export type BrowserEngine = 'puppeteer-real' | 'playwright';

export interface ProxyOptions {
    host: string;
    port: number;
    username?: string;
    password?: string;
}

export interface BrowserLaunchOptions {
    proxy?: ProxyOptions;
    headless?: boolean;
    viewport?: { width: number; height: number };
    userDataDir?: string;
    lang?: string;
    executablePath?: string;
}

export interface GotoOptions {
    waitForCf?: boolean;
    timeoutMs?: number;
}

export interface ClickByTextOptions {
    timeoutMs?: number;
    exact?: boolean;
    /** 优先使用的按钮 CSS 选择器。用于把状态机动作和 selectors.json 绑定。 */
    selector?: string;
    /** 诊断名称,出错时写入错误信息。 */
    debugName?: string;
}

export interface TypeOptions {
    delayMs?: number;
    clearFirst?: boolean;
    timeoutMs?: number;
}

export interface BrowserAdapter {
    readonly engine: BrowserEngine;

    launch(opts: BrowserLaunchOptions): Promise<void>;
    close(): Promise<void>;

    /** 导航并(可选)等待 CF Turnstile 通过。 */
    goto(url: string, opts?: GotoOptions): Promise<void>;
    /** 显式等待 Cloudflare 验证通过。 */
    waitForCloudflare(timeoutMs?: number): Promise<void>;

    /** 抓取页面快照(URL/text/inputs/buttons)——状态机唯一输入。 */
    snapshot(): Promise<PageSnapshot>;
    /** 在页面上下文执行 JS(读数据)。 */
    evaluate<T>(fn: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T>;

    /** 通过可见文字点击按钮(完整鼠标事件链,兼容 React)。 */
    clickButtonByText(text: string, opts?: ClickByTextOptions): Promise<void>;
    /** 用 React 兼容方式给输入框赋值(底层做 _valueTracker 绕过)。 */
    setInputValue(selector: string, value: string, opts?: TypeOptions): Promise<void>;
    /** 模拟键盘逐字输入。 */
    type(selector: string, text: string, opts?: TypeOptions): Promise<void>;
    /** 等待选择器出现。 */
    waitForSelector(selector: string, timeoutMs?: number): Promise<void>;

    /** 监听请求,匹配回调 URL 则调 handler;返回取消监听函数(OAuth code 捕获用)。 */
    onRequestUrlMatch(matcher: (url: URL) => boolean, handler: (url: URL) => void): () => void;

    screenshot(filename: string): Promise<string>;
    url(): string;
}
