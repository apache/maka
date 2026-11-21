import { describe, it, expect } from 'vitest';
import { normalizeDate } from '../../src/core/date.js';

describe('normalizeDate', () => {
    it('RFC822 带时区 → ISO UTC', () => {
        // +0800 的 03:21 → UTC 前一天 19:21
        expect(normalizeDate('Mon, 14 Jan 2024 03:21:00 +0800')).toBe('2024-01-13T19:21:00.000Z');
    });
    it('ISO 直传', () => {
        expect(normalizeDate('2024-01-14T00:00:00Z')).toBe('2024-01-14T00:00:00.000Z');
    });
    it('epoch 毫秒 → 有效 ISO', () => {
        const iso = normalizeDate(1705219260000);
        expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
    it('epoch 秒自动 *1000(与毫秒一致)', () => {
        expect(normalizeDate(1705219260)).toBe(normalizeDate(1705219260000));
    });
    it('Date 对象', () => {
        const d = new Date('2024-01-14T00:00:00Z');
        expect(normalizeDate(d)).toBe('2024-01-14T00:00:00.000Z');
    });
    it('空/非法返回空串', () => {
        expect(normalizeDate('')).toBe('');
        expect(normalizeDate(undefined)).toBe('');
        expect(normalizeDate(null)).toBe('');
        expect(normalizeDate('not a date')).toBe('');
    });
});
