/**
 * 邮件地址头解析(纯函数)。
 * 处理 `"Name" <a@b.com>, c@d.com` 这类多地址头,拆成 MailAddress[]。
 * IMAP envelope 的 address 对象、Graph emailAddress、Gmail header 字符串最终都走这里归一。
 */
import type { MailAddress } from '../types/mail.js';

const TOKEN_RE = /"[^"]*"\s*<[^>]+>|[^<]*<[^>]+>|[^\s,]+@[^\s,]+/g;

/** 解析地址头字符串为 MailAddress 数组。空/非法输入返回空数组。 */
export function parseAddressHeader(header: string | undefined | null): MailAddress[] {
    if (!header || typeof header !== 'string') return [];
    const result: MailAddress[] = [];
    const matches = header.match(TOKEN_RE) ?? [];
    for (const token of matches) {
        const trimmed = token.trim();
        if (!trimmed) continue;

        // "Name" <addr> 或 Name <addr>
        const namedBracket = trimmed.match(/^"?([^"]*)"?\\?\s*<([^>]+)>$/);
        if (namedBracket) {
            const name = (namedBracket[1] ?? '').trim();
            const email = (namedBracket[2] ?? '').trim().toLowerCase();
            if (email.includes('@')) result.push({ name: name || undefined, address: email });
            continue;
        }

        // <addr>
        const bracketOnly = trimmed.match(/^<([^>]+)>$/);
        if (bracketOnly) {
            const email = (bracketOnly[1] ?? '').trim().toLowerCase();
            if (email.includes('@')) result.push({ address: email });
            continue;
        }

        // bare addr
        const email = trimmed.toLowerCase();
        if (email.includes('@') && !email.includes(' ')) result.push({ address: email });
    }
    return result;
}

/** 取地址头的第一个地址(常见场景:From 头只有一个)。 */
export function firstAddress(header: string | undefined | null): MailAddress | null {
    const list = parseAddressHeader(header);
    return list[0] ?? null;
}
