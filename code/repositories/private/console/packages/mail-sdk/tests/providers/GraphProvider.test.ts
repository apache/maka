import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@microsoft/microsoft-graph-client', () => ({
    Client: { init: vi.fn() },
}));

vi.mock('@azure/identity', () => ({
    ClientSecretCredential: vi.fn().mockImplementation(function (this: any) {
        this.getToken = vi.fn(async () => ({ token: 'tok-cc' }));
    }),
    DeviceCodeCredential: vi.fn().mockImplementation(function (this: any) {
        this.getToken = vi.fn(async () => ({ token: 'tok-dc' }));
    }),
}));

import { Client } from '@microsoft/microsoft-graph-client';
import { ClientSecretCredential } from '@azure/identity';
import { GraphProvider } from '../../src/providers/graph/GraphProvider.js';
import { AuthError } from '../../src/core/errors.js';

let mockChain: any;
let mockClient: any;

beforeEach(() => {
    vi.clearAllMocks();
    mockChain = {
        select: vi.fn(() => mockChain),
        orderby: vi.fn(() => mockChain),
        top: vi.fn(() => mockChain),
        filter: vi.fn(() => mockChain),
        header: vi.fn(() => mockChain),
        search: vi.fn(() => mockChain),
        get: vi.fn(),
        patch: vi.fn(),
    };
    mockClient = { api: vi.fn(() => mockChain) };
    (Client as any).init.mockReturnValue(mockClient);
});

describe('GraphProvider', () => {
    it('connect:client_credentials 构造 ClientSecretCredential + init client', async () => {
        const p = new GraphProvider({ delegatedUser: 'u@c.com' });
        await p.connect({
            type: 'oauth',
            flow: 'client_credentials',
            clientId: 'cid',
            clientSecret: 'sec',
            tenantId: 'tid',
        });
        expect(ClientSecretCredential).toHaveBeenCalledWith('tid', 'cid', 'sec');
        expect((Client as any).init).toHaveBeenCalled();
        expect(p.isConnected()).toBe(true);
        expect(p.mailbox).toBe('u@c.com');
    });

    it('connect:非 oauth 抛 AuthError', async () => {
        const p = new GraphProvider();
        await expect(p.connect({ type: 'password', user: 'x', password: 'y' } as never)).rejects.toBeInstanceOf(AuthError);
    });

    it('listFolders:wellKnownName 映射 specialRole', async () => {
        mockChain.get.mockResolvedValue({
            value: [
                { id: 'f1', displayName: 'Inbox', wellKnownName: 'inbox', unreadItemCount: 3, totalItemCount: 10 },
                { id: 'f2', displayName: 'Sent', wellKnownName: 'sent' },
            ],
        });
        const p = new GraphProvider({ delegatedUser: 'u@c.com' });
        await p.connect({ type: 'oauth', flow: 'client_credentials', clientId: 'c', clientSecret: 's', tenantId: 't' });
        const folders = await p.listFolders();
        expect(mockClient.api).toHaveBeenCalledWith('/users/u@c.com/mailFolders');
        expect(folders[0]?.specialRole).toBe('inbox');
        expect(folders[0]?.unreadCount).toBe(3);
        expect(folders[1]?.specialRole).toBe('sent');
    });

    it('listMessages:select + unreadOnly filter + 字段映射', async () => {
        mockChain.get.mockResolvedValue({
            value: [
                {
                    id: 'm1',
                    subject: 'Hi',
                    from: { emailAddress: { address: 'a@b.com', name: 'Alice' } },
                    toRecipients: [{ emailAddress: { address: 'u@c.com' } }],
                    receivedDateTime: '2024-01-14T00:00:00Z',
                    isRead: false,
                    hasAttachments: false,
                    bodyPreview: 'preview...',
                },
            ],
        });
        const p = new GraphProvider({ delegatedUser: 'u@c.com' });
        await p.connect({ type: 'oauth', flow: 'client_credentials', clientId: 'c', clientSecret: 's', tenantId: 't' });
        const result = await p.listMessages({ unreadOnly: true });
        expect(mockChain.select).toHaveBeenCalled();
        expect(mockChain.filter).toHaveBeenCalledWith('isRead eq false');
        expect(mockChain.orderby).toHaveBeenCalledWith('receivedDateTime desc');
        const m = result.messages[0];
        expect(m?.subject).toBe('Hi');
        expect(m?.from?.address).toBe('a@b.com');
        expect(m?.from?.name).toBe('Alice');
        expect(m?.read).toBe(false);
        expect(m?.providerName).toBe('graph');
    });

    it('getMessage:body 解析(text/html)', async () => {
        mockChain.get.mockResolvedValue({
            value: undefined,
        });
        // 第二次 get(getMessage)
        mockChain.get.mockResolvedValueOnce({
            id: 'm1',
            subject: 'Full',
            from: { emailAddress: { address: 'a@b.com' } },
            body: { contentType: 'html', content: '<p>hi</p>' },
            receivedDateTime: '2024-01-14T00:00:00Z',
            isRead: true,
            hasAttachments: false,
        });
        const p = new GraphProvider({ delegatedUser: 'u@c.com' });
        await p.connect({ type: 'oauth', flow: 'client_credentials', clientId: 'c', clientSecret: 's', tenantId: 't' });
        const m = await p.getMessage('m1');
        expect(m.html).toBe('<p>hi</p>');
        expect(m.read).toBe(true);
    });
});
