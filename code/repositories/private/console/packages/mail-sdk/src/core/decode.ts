/**
 * 编码解码(纯函数):base64 / base64url / quoted-printable / RFC2047 encoded-word。
 * 各适配器收到编码后的正文/主题时统一走这里解码。
 */

export function decodeBase64(s: string): string {
    return Buffer.from(s.replace(/\s+/g, ''), 'base64').toString('utf8');
}

export function decodeBase64Url(s: string): string {
    return Buffer.from(s.replace(/\s+/g, ''), 'base64url').toString('utf8');
}

/** 解码 quoted-printable(=XX 字节序列,=\r\n / =\n 软换行)。 */
export function decodeQuotedPrintable(s: string): string {
    const bytes: number[] = [];
    let i = 0;
    while (i < s.length) {
        const ch = s[i]!;
        if (ch === '=') {
            const next1 = s[i + 1];
            const next2 = s[i + 2];
            if (next1 === '\r' && next2 === '\n') {
                i += 3;
                continue;
            }
            if (next1 === '\n') {
                i += 2;
                continue;
            }
            const hex = s.slice(i + 1, i + 3);
            if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
                bytes.push(parseInt(hex, 16));
                i += 3;
                continue;
            }
        }
        bytes.push(ch.charCodeAt(0));
        i++;
    }
    return Buffer.from(bytes).toString('utf8');
}

const ENCODED_WORD_RE = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;

/** 解码 RFC2047 encoded-word(主题里的 =?UTF-8?B?...?= / =?UTF-8?Q?...?= )。 */
export function decodeEncodedWords(s: string): string {
    if (!s || !s.includes('=?')) return s;
    return s.replace(ENCODED_WORD_RE, (match, _charset: string, encoding: string, text: string) => {
        try {
            if (encoding.toUpperCase() === 'B') {
                return Buffer.from(text, 'base64').toString('utf8');
            }
            // Q encoding: =XX 十六进制, _ 表示空格
            const q = text
                .replace(/_/g, ' ')
                .replace(/=([0-9A-Fa-f]{2})/g, (_m: string, h: string) => String.fromCharCode(parseInt(h, 16)));
            return Buffer.from(q, 'latin1').toString('utf8');
        } catch {
            return match;
        }
    });
}
