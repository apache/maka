/**
 * PKCE(Proof Key for Code Exchange)参数生成,纯函数。
 * OAuth 2.0 公客户端用 PKCE 替代 client_secret 防止授权码截获。
 * 迁移自现有 oauthService.js 的 PKCE 逻辑。
 */
import crypto from 'node:crypto';

export interface PkceParams {
    codeVerifier: string;
    codeChallenge: string;
    state: string;
}

/** 生成一组新的 PKCE 参数(code_verifier + S256 code_challenge + state)。 */
export function generatePkce(): PkceParams {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');
    return { codeVerifier, codeChallenge, state };
}

/** 校验 code_challenge 是否由给定 code_verifier 经 S256 派生(测试/自检用)。 */
export function verifyPkceChallenge(codeVerifier: string, codeChallenge: string): boolean {
    const expected = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    return expected === codeChallenge;
}
