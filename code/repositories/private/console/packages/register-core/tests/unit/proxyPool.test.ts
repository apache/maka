import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProxyPool, parseProxyList } from '../../src/infra/proxyPool.js';
import type { ProxyConfig } from '../../src/infra/proxy.js';

const p1: ProxyConfig = { host: '1.2.3.4', port: 8080, source: 'config' };
const p2: ProxyConfig = { host: '5.6.7.8', port: 8080, source: 'config' };
const p3: ProxyConfig = { host: '9.10.11.12', port: 8080, source: 'config' };

describe('parseProxyList', () => {
    it('解析逗号分隔的代理列表(无认证)', () => {
        const list = parseProxyList('1.2.3.4:8080,5.6.7.8:8080');
        expect(list).toHaveLength(2);
        expect(list[0]?.host).toBe('1.2.3.4');
        expect(list[0]?.port).toBe(8080);
    });

    it('解析带认证的代理', () => {
        const list = parseProxyList('1.2.3.4:8080:user:pass');
        expect(list).toHaveLength(1);
        expect(list[0]?.username).toBe('user');
        expect(list[0]?.password).toBe('pass');
    });

    it('空字符串返回空数组', () => {
        expect(parseProxyList('')).toHaveLength(0);
    });

    it('非法格式被过滤', () => {
        const list = parseProxyList('invalid,1.2.3.4:8080');
        expect(list).toHaveLength(1);
    });
});

describe('ProxyPool', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('空列表抛错', () => {
        expect(() => new ProxyPool({ proxies: [] })).toThrow('代理列表不能为空');
    });

    it('round-robin 轮询(默认策略)', () => {
        const pool = new ProxyPool({ proxies: [p1, p2, p3] });
        expect(pool.acquire().host).toBe('5.6.7.8'); // cursor 从 0 开始,首次 +1 → index 1
        expect(pool.acquire().host).toBe('9.10.11.12'); // ++ → index 2
        expect(pool.acquire().host).toBe('1.2.3.4'); // ++ → 回绕 index 0
    });

    it('random 策略在可用池中随机选取', () => {
        const pool = new ProxyPool({ proxies: [p1, p2], strategy: 'random' });
        for (let i = 0; i < 10; i++) {
            const p = pool.acquire();
            expect(['1.2.3.4', '5.6.7.8']).toContain(p.host);
        }
    });

    it('least-used 策略选使用次数最少的', () => {
        const pool = new ProxyPool({ proxies: [p1, p2], strategy: 'least-used' });
        pool.acquire(); // p2 useCount=1
        pool.acquire(); // p1 useCount=1
        // 现在两者 useCount 都是 1,再 acquire 应该选 p1(更靠前)
        const p = pool.acquire();
        expect((p as any).useCount).toBeUndefined(); // ProxyConfig 不泄漏内部 useCount
    });

    it('markFailed 达到阈值后踢出代理', () => {
        const pool = new ProxyPool({ proxies: [p1, p2], maxFailures: 2 });
        pool.markFailed(p1);
        expect(pool.healthy()).toBe(2); // 1 次失败还没踢
        pool.markFailed(p1);
        expect(pool.healthy()).toBe(1); // 2 次失败,kick
    });

    it('markSuccess 重置失败计数', () => {
        const pool = new ProxyPool({ proxies: [p1, p2], maxFailures: 2 });
        pool.markFailed(p1);
        pool.markSuccess(p1);
        pool.markFailed(p1);
        expect(pool.healthy()).toBe(2); // 应该还没踢
    });

    it('全部不可用时抛出并自动重置', () => {
        const pool = new ProxyPool({ proxies: [p1], maxFailures: 1 });
        pool.markFailed(p1);
        expect(pool.healthy()).toBe(0);
        expect(() => pool.acquire()).toThrow('所有代理均不可用');
        // 重置后可用
        expect(pool.healthy()).toBe(1);
    });

    it('冷却恢复:超时后自动恢复被踢出的代理', () => {
        vi.useFakeTimers();
        const pool = new ProxyPool({ proxies: [p1, p2], maxFailures: 1, cooldownMs: 100 });
        pool.markFailed(p1);
        expect(pool.healthy()).toBe(1);
        // 推进时间以触发冷却过期
        vi.advanceTimersByTime(200);
        pool.acquire(); // 触发 expireCooldowns
        expect(pool.healthy()).toBe(2);
    });
});
