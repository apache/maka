import { describe, it, expect } from 'vitest';
import { decodeJwtPayload, readAccountIdFromToken } from '../../src/oauth/jwtReader.js';

function makeJwt(payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${header}.${body}.sig`;
}

describe('jwtReader', () => {
    it('解码 payload', () => {
        const p = decodeJwtPayload(makeJwt({ sub: 'user-1' }));
        expect(p?.sub).toBe('user-1');
    });
    it('读取 OpenAI account_id', () => {
        const token = makeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-xyz' } });
        expect(readAccountIdFromToken(token)).toBe('acc-xyz');
    });
    it('无 account_id 返回空串', () => {
        expect(readAccountIdFromToken(makeJwt({ sub: 'x' }))).toBe('');
    });
    it('非法 token 返回 null', () => {
        expect(decodeJwtPayload('not-a-jwt')).toBeNull();
        expect(decodeJwtPayload('')).toBeNull();
    });
});
