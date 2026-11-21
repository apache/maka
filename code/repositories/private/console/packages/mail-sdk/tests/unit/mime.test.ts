import { describe, it, expect } from 'vitest';
import { extractMimePart } from '../../src/core/mime.js';

describe('extractMimePart', () => {
    it('非 multipart:返回整体正文', () => {
        const raw = 'Content-Type: text/plain\r\n\r\nHello world';
        expect(extractMimePart(raw, 'text/plain')).toBe('Hello world');
    });
    it('multipart:提取 text/plain', () => {
        const raw = [
            'Content-Type: multipart/alternative; boundary="BOUND"',
            '',
            '--BOUND',
            'Content-Type: text/plain',
            '',
            'plain body',
            '--BOUND',
            'Content-Type: text/html',
            '',
            '<p>html body</p>',
            '--BOUND--',
        ].join('\r\n');
        expect(extractMimePart(raw, 'text/plain')).toBe('plain body');
    });
    it('multipart:提取 text/html', () => {
        const raw = [
            'Content-Type: multipart/alternative; boundary="BOUND"',
            '',
            '--BOUND',
            'Content-Type: text/plain',
            '',
            'plain',
            '--BOUND',
            'Content-Type: text/html',
            '',
            '<p>html</p>',
            '--BOUND--',
        ].join('\r\n');
        expect(extractMimePart(raw, 'text/html')).toBe('<p>html</p>');
    });
    it('未找到指定 part 返回 undefined', () => {
        const raw = [
            'Content-Type: multipart/alternative; boundary="X"',
            '',
            '--X',
            'Content-Type: text/plain',
            '',
            'only',
            '--X--',
        ].join('\r\n');
        expect(extractMimePart(raw, 'text/html')).toBeUndefined();
    });
});
