import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../../src/infra/rateLimiter.js';

describe('RateLimiter', () => {
    it('额度内不阻塞', async () => {
        const rl = new RateLimiter({ maxPerWindow: 2, windowMs: 1000 });
        await expect(rl.acquire()).resolves.toBeUndefined();
        await expect(rl.acquire()).resolves.toBeUndefined();
    });
    it('超额时 wouldBlock 为 true', () => {
        const rl = new RateLimiter({ maxPerWindow: 1, windowMs: 1000 });
        expect(rl.wouldBlock(1000)).toBe(false);
        (rl as unknown as { timestamps: number[] }).timestamps.push(1000);
        expect(rl.wouldBlock(1100)).toBe(true);
    });
    it('窗口外过期不计数', () => {
        const rl = new RateLimiter({ maxPerWindow: 1, windowMs: 1000 });
        (rl as unknown as { timestamps: number[] }).timestamps.push(0); // 远早于窗口
        expect(rl.wouldBlock(5000)).toBe(false);
    });
    it('非法参数抛错', () => {
        expect(() => new RateLimiter({ maxPerWindow: 0, windowMs: 1000 })).toThrow();
    });
});
