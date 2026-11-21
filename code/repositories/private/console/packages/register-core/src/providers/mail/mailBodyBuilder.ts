/**
 * 邮件正文提取(纯函数)。
 * 不同邮箱 provider 返回的邮件字段不一(legacy 给 raw,text/html 可能缺;yyds 需 hydrate)。
 * 本函数统一从 {text, html, raw} 提取出可搜验证码的字符串。
 * 迁移自现有 index.js 的 buildMailBody。
 */

export interface RawMail {
    raw?: string;
    text?: string;
    html?: string;
}

/** 提取优先级:text → html → 从 raw MIME 解析正文段。 */
export function buildMailBody(mail: RawMail): string {
    const text = typeof mail.text === 'string' ? mail.text : '';
    if (text) return text;

    const html = typeof mail.html === 'string' ? mail.html : '';
    if (html) return html;

    const raw = typeof mail.raw === 'string' ? mail.raw : '';
    if (!raw) return '';

    // 尝试匹配 text/html MIME 段
    const htmlMatch = raw.match(/Content-Type:\s*text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:--[^\r\n]+--|$)/i);
    if (htmlMatch?.[1]) return htmlMatch[1];

    // 否则按空行分段,取最后几段(通常是正文)
    const parts = raw.split(/\r?\n\r?\n/);
    if (parts.length > 1) {
        return parts.slice(Math.max(1, parts.length - 3)).join('\n');
    }
    return raw;
}
