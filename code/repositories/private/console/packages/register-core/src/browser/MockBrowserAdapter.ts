/**
 * 测试用 Mock 浏览器适配器:可脚本化返回 PageSnapshot,并记录所有方法调用。
 * 这是把 2280 行上帝类逻辑降为可测的关键——Orchestrator 依赖接口,mock 注入预设快照序列,
 * 测试断言"给定页面状态,Orchestrator 调用了正确的 adapter 方法"。
 */
import type { PageSnapshot } from '../state/states.js';
import type {
    BrowserAdapter,
    BrowserEngine,
    BrowserLaunchOptions,
    ClickByTextOptions,
    GotoOptions,
    TypeOptions,
} from './BrowserAdapter.js';

export interface RecordedCall {
    readonly method: string;
    readonly args: readonly unknown[];
}

function emptySnapshot(url: string): PageSnapshot {
    return {
        url,
        title: '',
        text: '',
        inputs: [],
        buttonLabels: [],
        hasCfChallenge: false,
        errorType: null,
        errorContext: '',
        capturedAt: Date.now(),
    };
}

export class MockBrowserAdapter implements BrowserAdapter {
    readonly engine: BrowserEngine = 'puppeteer-real';

    private readonly snapshotQueue: PageSnapshot[] = [];
    private readonly requestHandlers: Array<{ matcher: (u: URL) => boolean; handler: (u: URL) => void }> = [];
    private currentUrl = '';
    private launched = false;
    private evaluateReturn: unknown = undefined;

    /** 记录所有调用(测试断言用)。 */
    readonly calls: RecordedCall[] = [];

    // ---- 脚本化注入(测试设置) ----
    queueSnapshot(snapshot: PageSnapshot): void {
        this.snapshotQueue.push(snapshot);
    }
    queueSnapshots(snapshots: readonly PageSnapshot[]): void {
        for (const s of snapshots) this.snapshotQueue.push(s);
    }
    setEvaluateReturn(value: unknown): void {
        this.evaluateReturn = value;
    }
    get isLaunched(): boolean {
        return this.launched;
    }

    // ---- 接口实现 ----
    private record(method: string, args: readonly unknown[]): void {
        this.calls.push({ method, args });
    }

    async launch(opts: BrowserLaunchOptions): Promise<void> {
        this.launched = true;
        this.record('launch', [opts]);
    }
    async close(): Promise<void> {
        this.launched = false;
        this.record('close', []);
    }
    async goto(url: string, opts?: GotoOptions): Promise<void> {
        this.currentUrl = url;
        this.record('goto', [url, opts]);
    }
    async waitForCloudflare(timeoutMs?: number): Promise<void> {
        this.record('waitForCloudflare', [timeoutMs]);
    }
    async snapshot(): Promise<PageSnapshot> {
        this.record('snapshot', []);
        return this.snapshotQueue.shift() ?? emptySnapshot(this.currentUrl);
    }
    async evaluate<T>(fn: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T> {
        this.record('evaluate', [fn, ...args]);
        return this.evaluateReturn as T;
    }
    async clickButtonByText(text: string, opts?: ClickByTextOptions): Promise<void> {
        this.record('clickButtonByText', [text, opts]);
    }
    async setInputValue(selector: string, value: string, opts?: TypeOptions): Promise<void> {
        this.record('setInputValue', [selector, value, opts]);
    }
    async type(selector: string, text: string, opts?: TypeOptions): Promise<void> {
        this.record('type', [selector, text, opts]);
    }
    async waitForSelector(selector: string, timeoutMs?: number): Promise<void> {
        this.record('waitForSelector', [selector, timeoutMs]);
    }
    onRequestUrlMatch(matcher: (u: URL) => boolean, handler: (u: URL) => void): () => void {
        this.record('onRequestUrlMatch', []);
        const entry = { matcher, handler };
        this.requestHandlers.push(entry);
        return () => {
            const idx = this.requestHandlers.indexOf(entry);
            if (idx >= 0) this.requestHandlers.splice(idx, 1);
        };
    }
    async screenshot(filename: string): Promise<string> {
        this.record('screenshot', [filename]);
        return filename;
    }
    url(): string {
        return this.currentUrl;
    }

    /** 测试辅助:模拟浏览器发出一个请求,触发所有匹配的 handler。 */
    simulateRequest(rawUrl: string): void {
        const u = new URL(rawUrl);
        for (const { matcher, handler } of [...this.requestHandlers]) {
            if (matcher(u)) handler(u);
        }
    }

    /** 测试辅助:断言某方法被调用过 N 次。 */
    callCount(method: string): number {
        return this.calls.filter((c) => c.method === method).length;
    }
}
