import { describe, it, expect } from 'vitest';
import { createProvider } from '../../src/factory.js';

describe('createProvider', () => {
    it('tempmail + anonymous → TempMailProvider', () => {
        const p = createProvider({ provider: 'tempmail', credential: { type: 'anonymous' } });
        expect(p.name).toBe('tempmail');
    });
    it('imap + password → ImapProvider', () => {
        const p = createProvider({
            provider: 'imap',
            credential: { type: 'password', user: 'a@b.com', password: 'p' },
        });
        expect(p.name).toBe('imap');
    });
    it('graph / gmail 返回对应 provider', () => {
        const g = createProvider({
            provider: 'graph',
            credential: { type: 'oauth', flow: 'client_credentials', clientId: 'x', clientSecret: 'y', tenantId: 't' },
        });
        expect(g.name).toBe('graph');
        const gm = createProvider({
            provider: 'gmail',
            credential: { type: 'oauth', flow: 'installed', clientId: 'x', clientSecret: 'y', refreshToken: 'z' },
        });
        expect(gm.name).toBe('gmail');
    });
    it('非法凭据结构抛错(zod)', () => {
        expect(() =>
            createProvider({
                provider: 'imap',
                credential: { type: 'password' },
            } as never),
        ).toThrow();
    });
});
