/**
 * JWT 读取(纯函数,不验签,仅解码 payload)。
 * 用于从 OpenAI access_token 提取 chatgpt_account_id,落盘到 token 文件。
 * 迁移自现有 oauthService.js 的 exchangeTokenAndSave 中的 JWT 解析段。
 */

export interface JwtPayload {
    readonly [key: string]: unknown;
}

/** 解码 JWT 的 payload 段(base64url → JSON)。格式非法返回 null。 */
export function decodeJwtPayload(token: string): JwtPayload | null {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    try {
        const json = Buffer.from(parts[1]!, 'base64url').toString('utf8');
        return JSON.parse(json) as JwtPayload;
    } catch {
        return null;
    }
}

const OPENAI_AUTH_NS = 'https://api.openai.com/auth';

/**
 * 从 OpenAI access_token 提取 chatgpt_account_id。
 * 该字段嵌套在 payload 的 `https://api.openai.com/auth` 命名空间下。
 */
export function readAccountIdFromToken(token: string): string {
    const payload = decodeJwtPayload(token);
    if (!payload) return '';
    const authNs = (payload[OPENAI_AUTH_NS] ?? {}) as { readonly chatgpt_account_id?: unknown };
    return typeof authNs.chatgpt_account_id === 'string' ? authNs.chatgpt_account_id : '';
}
