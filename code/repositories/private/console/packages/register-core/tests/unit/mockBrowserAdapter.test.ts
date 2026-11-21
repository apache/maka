import { describe, it, expect } from 'vitest';
import { MockBrowserAdapter } from '../../src/browser/MockBrowserAdapter.js';
import type { PageSnapshot } from '../../src/state/states.js';

function snap(url: string): PageSnapshot {
    return { url, title: '', text: '', inputs: [], buttonLabels: [], hasCfChallenge: false, errorType: null, errorContext: '', capturedAt: 1 };
}

describe('MockBrowserAdapter', () => {
    it('snapshot 按队列消费,耗尽后返回空快照', async () => {
        const m = new MockBrowserAdapter();
        m.queueSnapshots([snap('a'), snap('b')]);
        expect((await m.snapshot()).url).toBe('a');
        expect((await m.snapshot()).url).toBe('b');
        expect((await m.snapshot()).url).toBe(''); // 耗尽
    });
    it('记录方法调用并统计次数', async () => {
        const m = new MockBrowserAdapter();
        await m.goto('https://x.com');
        await m.clickButtonByText('继续');
        await m.clickButtonByText('继续');
        expect(m.callCount('goto')).toBe(1);
        expect(m.callCount('clickButtonByText')).toBe(2);
    });
    it('onRequestUrlMatch 匹配时触发 handler,取消监听后不再触发', () => {
        const m = new MockBrowserAdapter();
        let captured: string | null = null;
        const unsub = m.onRequestUrlMatch(
            (u) => u.searchParams.has('code'),
            (u) => {
                captured = u.toString();
            },
        );
        m.simulateRequest('http://localhost:1455/auth/callback?code=abc&state=s');
        expect(captured).toContain('code=abc');
        unsub();
        captured = null;
        m.simulateRequest('http://localhost:1455/auth/callback?code=def');
        expect(captured).toBeNull();
    });
    it('launch/close 切换 isLaunched', async () => {
        const m = new MockBrowserAdapter();
        await m.launch({});
        expect(m.isLaunched).toBe(true);
        await m.close();
        expect(m.isLaunched).toBe(false);
    });
});
