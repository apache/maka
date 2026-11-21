import { describe, it, expect, vi } from 'vitest';
import type { AxiosInstance } from 'axios';
import { TempMailProvider } from '../../src/providers/tempmail/TempMailProvider.js';
import { AuthError } from '../../src/core/errors.js';

function makeHttp(handler: (method: string, url: string, body?: unknown) => unknown): AxiosInstance {
    return {
        get: vi.fn(async (url: string) => handler('get', url)),
        post: vi.fn(async (url: string, body: unknown) => handler('post', url, body)),
        patch: vi.fn(async (url: string, body: unknown) => handler('patch', url, body)),
    } as unknown as AxiosInstance;
}

describe('TempMailProvider', () => {
    it('connect(新建):创建账号 + token,设置 mailbox', async () => {
        let posts = 0;
        const http = makeHttp((method, url) => {
            if (method === 'post' && url === '/token') {
                posts++;
                return { data: { token: 'jwt-123', id: 'acc-1' } };
            }
            if (method === 'post') {
                posts++;
                return { data: {} };
            }
            return { data: {} };
        });
        const p = new TempMailProvider({ httpClient: http, domain: 'test.com' });
        await p.connect({ type: 'anonymous', addressPrefix: 'myname' });
        expect(p.mailbox).toBe('myname@test.com');
        expect(p.isConnected()).toBe(true);
        expect(posts).toBeGreaterThanOrEqual(2);
    });

    it('connect(已有 token):直接复用,GET /me 拿地址', async () => {
        const http = makeHttp((method, url) => {
            if (method === 'get' && url === '/me') return { data: { address: 'existing@x.com' } };
            return { data: {} };
        });
        const p = new TempMailProvider({ httpClient: http });
        await p.connect({ type: 'anonymous', token: 'existing-jwt' });
        expect(p.mailbox).toBe('existing@x.com');
    });

    it('connect 非 anonymous 抛 AuthError', async () => {
        const p = new TempMailProvider();
        await expect(
            p.connect({ type: 'password', user: 'x', password: 'y' } as never),
        ).rejects.toBeInstanceOf(AuthError);
    });

    it('listFolders 返回固定 inbox', async () => {
        const p = new TempMailProvider({ domain: 'x.com' });
        const folders = await p.listFolders();
        expect(folders).toHaveLength(1);
        expect(folders[0]?.specialRole).toBe('inbox');
    });

    it('listMessages 字段正确映射', async () => {
        const http = makeHttp((method, url) => {
            if (method === 'get' && url === '/me') return { data: { address: 'box@x.com' } };
            if (method === 'get' && url.includes('/messages')) {
                return {
                    data: {
                        'hydra:member': [
                            {
                                id: 'm1',
                                from: { address: 'a@b.com', name: 'Alice' },
                                subject: 'Hi',
                                createdAt: '2024-01-14T00:00:00+00:00',
                                seen: false,
                                hasAttachments: true,
                            },
                        ],
                    },
                };
            }
            return { data: {} };
        });
        const p = new TempMailProvider({ httpClient: http });
        await p.connect({ type: 'anonymous', token: 't' });
        const result = await p.listMessages({ limit: 10 });
        const m = result.messages[0];
        expect(m?.id).toBe('m1');
        expect(m?.from?.address).toBe('a@b.com');
        expect(m?.from?.name).toBe('Alice');
        expect(m?.subject).toBe('Hi');
        expect(m?.read).toBe(false);
        expect(m?.hasAttachment).toBe(true);
        expect(m?.providerName).toBe('tempmail');
        expect(m?.date).toBe('2024-01-14T00:00:00.000Z');
    });

    it('listMessages unreadOnly 过滤已读', async () => {
        const http = makeHttp((method, url) => {
            if (method === 'get' && url === '/me') return { data: { address: 'box@x.com' } };
            if (method === 'get' && url.includes('/messages')) {
                return {
                    data: {
                        'hydra:member': [
                            { id: 'a', seen: true, from: { address: 'x@y.com' } },
                            { id: 'b', seen: false, from: { address: 'x@y.com' } },
                        ],
                    },
                };
            }
            return { data: {} };
        });
        const p = new TempMailProvider({ httpClient: http });
        await p.connect({ type: 'anonymous', token: 't' });
        const result = await p.listMessages({ unreadOnly: true });
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0]?.id).toBe('b');
    });
});
