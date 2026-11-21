/**
 * Cloudflare 等待:轮询页面快照直到 CF Turnstile/五秒盾放行。
 * 独立职责,可被任意 BrowserAdapter 复用(测试时可注入 MockAdapter)。
 */
import type { BrowserAdapter } from './BrowserAdapter.js';

export class CloudflareGuard {
    constructor(private readonly adapter: BrowserAdapter) {}

    async wait(timeoutMs = 60_000, intervalMs = 1_500): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const snap = await this.adapter.snapshot();
            if (!snap.hasCfChallenge) return;
            await new Promise((r) => setTimeout(r, intervalMs));
        }
        throw new Error(`Cloudflare 等待超时(${timeoutMs}ms)`);
    }
}
