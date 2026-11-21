/**
 * MIME multipart 正文提取(纯函数,简化版)。
 * IMAP 的 RFC822 raw 或 temp-mail 的 /source 可能是完整 MIME,
 * 这里提供按 Content-Type 取指定 part 的能力。完整解析在 ImapProvider 用 mailparser。
 */

/** 从 raw MIME 提取指定 Content-Type(text/plain 或 text/html)的正文。非 multipart 返回整体正文。 */
export function extractMimePart(raw: string, contentType: 'text/plain' | 'text/html'): string | undefined {
    const ctMatch = raw.match(/Content-Type:\s*multipart\/[\w.+-]+;\s*boundary="?([^\r\n";]+)"?/i);
    if (!ctMatch) {
        const bodyStart = raw.indexOf('\r\n\r\n');
        return bodyStart >= 0 ? raw.slice(bodyStart + 4) : raw;
    }

    const boundary = ctMatch[1]!.trim();
    const parts = raw.split(`--${boundary}`);
    for (const part of parts) {
        const lower = part.toLowerCase();
        if (lower.includes(`content-type: ${contentType}`) || lower.includes(`content-type:${contentType}`)) {
            const bodyStart = part.indexOf('\r\n\r\n');
            if (bodyStart >= 0) {
                return part.slice(bodyStart + 4).replace(/(\r\n|\n)$/, '');
            }
        }
    }
    return undefined;
}
