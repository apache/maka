import { describe, it, expect } from 'vitest';
import { buildMailBody } from '../../src/providers/mail/mailBodyBuilder.js';

describe('buildMailBody', () => {
    it('优先 text', () => {
        expect(buildMailBody({ text: 'plain', html: '<b>x</b>', raw: 'r' })).toBe('plain');
    });
    it('次优先 html', () => {
        expect(buildMailBody({ html: '<b>html</b>' })).toBe('<b>html</b>');
    });
    it('raw 含 text/html 段时提取该段', () => {
        const raw = 'headers\r\nContent-Type: text/html\r\n\r\n<div>CODE 123456</div>\r\n--bound--';
        expect(buildMailBody({ raw })).toContain('123456');
    });
    it('raw 普通分段取末尾', () => {
        const raw = 'header1\r\n\r\nheader2\r\n\r\nbody content';
        expect(buildMailBody({ raw })).toContain('body content');
    });
    it('全空返回空串', () => {
        expect(buildMailBody({})).toBe('');
    });
});
