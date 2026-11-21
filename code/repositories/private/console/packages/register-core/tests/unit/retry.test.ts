import { describe, it, expect, vi } from 'vitest';
import { withRetry, isRetryableHttpError } from '../../src/infra/retry.js';

describe('withRetry', () => {
    it('首次成功不重试', async () => {
        const fn = vi.fn().mockResolvedValue('ok');
        await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
    });
    it('重试后成功', async () => {
        const fn = vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce('ok');
        await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(2);
    });
    it('达到上限抛最后一个错', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('always-fail'));
        await expect(withRetry(fn, { maxAttempts: 2, baseDelayMs: 1 })).rejects.toThrow('always-fail');
        expect(fn).toHaveBeenCalledTimes(2);
    });
    it('retryOn=false 立即抛', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('x'));
        await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, retryOn: () => false })).rejects.toThrow();
        expect(fn).toHaveBeenCalledTimes(1);
    });
});

describe('isRetryableHttpError', () => {
    it('5xx 可重试', () => {
        expect(isRetryableHttpError({ response: { status: 503 } })).toBe(true);
    });
    it('429 可重试', () => {
        expect(isRetryableHttpError({ response: { status: 429 } })).toBe(true);
    });
    it('4xx 不可重试', () => {
        expect(isRetryableHttpError({ response: { status: 404 } })).toBe(false);
    });
    it('网络错误可重试', () => {
        expect(isRetryableHttpError({ code: 'ECONNRESET' })).toBe(true);
        expect(isRetryableHttpError({ code: 'ETIMEDOUT' })).toBe(true);
    });
    it('无特征不可重试', () => {
        expect(isRetryableHttpError(new Error('plain'))).toBe(false);
    });
});
