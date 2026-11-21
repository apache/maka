import { describe, it, expect, vi, beforeEach } from 'vitest';

const { gmailMock } = vi.hoisted(() => ({
    gmailMock: {
        users: {
            labels: { list: vi.fn() },
            messages: { list: vi.fn(), get: vi.fn(), batchGet: vi.fn(), modify: vi.fn() },
        },
    },
}));

vi.mock('googleapis', () => ({
    google: {
        auth: {
            OAuth2: vi.fn().mockImplementation(function (this: any) {
                this.setCredentials = vi.fn();
            }),
            JWT: vi.fn().mockImplementation(function (this: any) {}),
        },
        gmail: vi.fn(() => gmailMock),
    },
}));

import { google } from 'googleapis';
import { GmailProvider } from '../../src/providers/gmail/GmailProvider.js';
import { AuthError } from '../../src/core/errors.js';

const gmailClient = google.gmail({ version: 'v1', auth: {} as never }) as unknown as {
    users: {
        labels: { list: ReturnType<typeof vi.fn> };
        messages: { list: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; batchGet: ReturnType<typeof vi.fn>; modify: ReturnType<typeof vi.fn> };
    };
};

beforeEach(() => {
    vi.clearAllMocks();
});

describe('GmailProvider', () => {
    it('connect:installed 构造 OAuth2 + setCredentials', async () => {
        const p = new GmailProvider();
        await p.connect({
            type: 'oauth',
            flow: 'installed',
            clientId: 'cid',
            clientSecret: 'sec',
            refreshToken: 'rt',
        });
        expect(google.auth.OAuth2).toHaveBeenCalledWith('cid', 'sec', 'urn:ietf:wg:oauth:2.0:oob');
        expect(p.isConnected()).toBe(true);
        expect(p.mailbox).toBe('(me)');
    });

    it('connect:非 oauth 抛 AuthError', async () => {
        const p = new GmailProvider();
        await expect(p.connect({ type: 'anonymous' } as never)).rejects.toBeInstanceOf(AuthError);
    });

    it('listFolders:label → role 映射', async () => {
        gmailClient.users.labels.list.mockResolvedValue({
            data: { labels: [{ id: 'INBOX', name: 'INBOX' }, { id: 'SENT', name: 'Sent' }, { id: 'Label_1', name: 'Custom' }] },
        });
        const p = new GmailProvider();
        await p.connect({ type: 'oauth', flow: 'installed', clientId: 'c', clientSecret: 's', refreshToken: 'r' });
        const folders = await p.listFolders();
        expect(folders[0]?.specialRole).toBe('inbox');
        expect(folders[1]?.specialRole).toBe('sent');
        expect(folders[2]?.specialRole).toBeUndefined();
    });

    it('listMessages:batchGet + 字段映射 + UNREAD→未读', async () => {
        gmailClient.users.messages.list.mockResolvedValue({
            data: { messages: [{ id: 'g1' }, { id: 'g2' }] },
        });
        const encoded = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
        gmailClient.users.messages.batchGet.mockResolvedValue({
            data: {
                messages: [
                    {
                        id: 'g1',
                        threadId: 't1',
                        labelIds: ['INBOX', 'UNREAD'],
                        internalDate: '1705219260000',
                        payload: {
                            headers: [
                                { name: 'Subject', value: 'Hello' },
                                { name: 'From', value: 'Alice <a@b.com>' },
                                { name: 'Date', value: 'Sun, 14 Jan 2024 07:21:00 +0000' },
                            ],
                            mimeType: 'multipart/alternative',
                            parts: [
                                { mimeType: 'text/plain', body: { data: encoded('plain body') } },
                                { mimeType: 'text/html', body: { data: encoded('<p>html</p>') } },
                            ],
                        },
                    },
                ],
            },
        });
        const p = new GmailProvider();
        await p.connect({ type: 'oauth', flow: 'installed', clientId: 'c', clientSecret: 's', refreshToken: 'r' });
        const result = await p.listMessages({ limit: 5 });
        const m = result.messages[0];
        expect(m?.id).toBe('g1');
        expect(m?.subject).toBe('Hello');
        expect(m?.from?.address).toBe('a@b.com');
        expect(m?.from?.name).toBe('Alice');
        expect(m?.read).toBe(false); // 含 UNREAD
        expect(m?.text).toBe('plain body');
        expect(m?.html).toBe('<p>html</p>');
        expect(m?.threadId).toBe('t1');
    });

    it('search:拼 Gmail 查询语法', async () => {
        gmailClient.users.messages.list.mockResolvedValue({ data: { messages: [] } });
        const p = new GmailProvider();
        await p.connect({ type: 'oauth', flow: 'installed', clientId: 'c', clientSecret: 's', refreshToken: 'r' });
        await p.search({ from: 'alice', subject: 'inv', unreadOnly: true });
        expect(gmailClient.users.messages.list).toHaveBeenCalledWith(
            expect.objectContaining({ q: 'from:alice subject:inv is:unread' }),
        );
    });
});
