import { describe, it, expect } from 'vitest';
import { generatePkce, verifyPkceChallenge } from '../../src/oauth/PkceService.js';

describe('PKCE', () => {
    it('生成三个非空字段', () => {
        const p = generatePkce();
        expect(p.codeVerifier.length).toBeGreaterThan(10);
        expect(p.codeChallenge.length).toBeGreaterThan(10);
        expect(p.state).toMatch(/^[0-9a-f]+$/);
    });
    it('challenge 是 verifier 的 S256 派生', () => {
        const p = generatePkce();
        expect(verifyPkceChallenge(p.codeVerifier, p.codeChallenge)).toBe(true);
    });
    it('错误 verifier 校验失败', () => {
        const p = generatePkce();
        expect(verifyPkceChallenge('wrong-verifier', p.codeChallenge)).toBe(false);
    });
    it('两次生成不同(随机性)', () => {
        expect(generatePkce().codeVerifier).not.toBe(generatePkce().codeVerifier);
    });
});
