import { describe, it, expect } from 'vitest';
import { decodeBase64, decodeBase64Url, decodeQuotedPrintable, decodeEncodedWords } from '../../src/core/decode.js';

describe('decode', () => {
    it('base64', () => {
        expect(decodeBase64(Buffer.from('hello').toString('base64'))).toBe('hello');
    });
    it('base64 去空白', () => {
        expect(decodeBase64('a G V s b G 8=')).toBe('hello');
    });
    it('base64url', () => {
        expect(decodeBase64Url(Buffer.from('a@b.com').toString('base64url'))).toBe('a@b.com');
    });

    it('quoted-printable: ASCII 直传', () => {
        expect(decodeQuotedPrintable('hello')).toBe('hello');
    });
    it('quoted-printable: =XX 字节(UTF-8 多字节)', () => {
        expect(decodeQuotedPrintable('=C3=A9')).toBe('é');
    });
    it('quoted-printable: 软换行 =\\r\\n', () => {
        expect(decodeQuotedPrintable('a=\r\nb')).toBe('ab');
    });
    it('quoted-printable: 软换行 =\\n', () => {
        expect(decodeQuotedPrintable('a=\nb')).toBe('ab');
    });

    it('encoded-word B(中文)', () => {
        const b = Buffer.from('你好', 'utf8').toString('base64');
        expect(decodeEncodedWords(`=?UTF-8?B?${b}?=`)).toBe('你好');
    });
    it('encoded-word Q', () => {
        expect(decodeEncodedWords('=?UTF-8?Q?caf=C3=A9?=')).toBe('café');
    });
    it('encoded-word Q 下划线=空格', () => {
        expect(decodeEncodedWords('=?UTF-8?Q?hello_world?=')).toBe('hello world');
    });
    it('无 encoded-word 原样返回', () => {
        expect(decodeEncodedWords('plain subject')).toBe('plain subject');
    });
});
