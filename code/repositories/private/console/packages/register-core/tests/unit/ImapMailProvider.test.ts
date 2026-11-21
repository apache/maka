import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock mail-sdk 的 ImapProvider,避免真实 IMAP 连接。
const mockConnect = vi.fn(async () => {});
const mockIsConnected = vi.fn(() => true);
const mockSearch = vi.fn(async () => ({
    messages: [
        {
            id: '1',
            subject: 'Test subject',
            from: { address: 'sender@test.com', name: 'Sender' },
            to: [{ address: 'me@test.com' }],
            date: '2024-01-01T00:00:00.000Z',
            text: 'plain body',
            html: '<p>html</p>',
        },
    ],
}));
const mockListMessages = vi.fn(async () => ({ messages: [] }));

vi.mock('@ggbdpq/mail-sdk', () => ({
    ImapProvider: vi.fn(function (this: Record<string, unknown>) {
        this.connect = mockConnect;
        this.isConnected = mockIsConnected;
        this.search = mockSearch;
        this.listMessages = mockListMessages;
    }),
}));

import { ImapMailProvider } from '../../src/providers/mail/ImapMailProvider.js';
import { asEmail } from '../../src/types/brand.js';

describe('ImapMailProvider', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIsConnected.mockReturnValue(true);
    });

    it('构造时缺少 user 或 password 抛错', () => {
        expect(() => new ImapMailProvider({ user: '', password: '' })).toThrow('user / password 必填');
    });

    it('createAddress 返回配置的邮箱地址并导出完整的 session', async () => {
        const p = new ImapMailProvider({ user: 'a@gmail.com', password: 'p' });
        const created = await p.createAddress();

        expect(created.address).toBe('a@gmail.com');
        expect(created.session.provider).toBe('imap');
        expect(created.session.address).toBe('a@gmail.com');
        expect(created.session.imapUser).toBe('a@gmail.com');
        expect(created.session.imapPassword).toBe('p');
        expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it('getMails 适配消息字段', async () => {
        const p = new ImapMailProvider({ user: 'a@gmail.com', password: 'p' });
        await p.createAddress(); // 确保已连接

        const mails = await p.getMails(5);
        expect(mails).toHaveLength(1);
        expect(mails[0]?.subject).toBe('Test subject');
        expect(mails[0]?.text).toBe('plain body');
        expect(mails[0]?.html).toBe('<p>html</p>');
        expect(mails[0]?.createdAt).toBe('2024-01-01T00:00:00.000Z');
    });

    it('getInboxUrl 返回 null(IMAP 无浏览器收件箱)', () => {
        const p = new ImapMailProvider({ user: 'a@gmail.com', password: 'p' });
        expect(p.getInboxUrl()).toBeNull();
    });

    it('getEmail 在 connect 前返回 null', () => {
        const p = new ImapMailProvider({ user: 'a@gmail.com', password: 'p' });
        expect(p.getEmail()).toBeNull();
    });

    it('useExistingAddressSession 从持久化 session 恢复', () => {
        const p = new ImapMailProvider({ user: 'a@gmail.com', password: 'p' });
        p.useExistingAddressSession({
            provider: 'imap',
            address: 'stored@gmail.com' as ReturnType<typeof asEmail>,
            imapUser: 'stored@gmail.com',
            imapPassword: 'stored_pass',
        });
        expect(p.getEmail()).toBe('stored@gmail.com');
    });

    it('useExistingAddressSession 缺少 imapUser 或 imapPassword 抛错', () => {
        const p = new ImapMailProvider({ user: 'a@gmail.com', password: 'p' });
        expect(() =>
            p.useExistingAddressSession({
                provider: 'imap',
                address: 'a@gmail.com' as ReturnType<typeof asEmail>,
            }),
        ).toThrow('缺少 imapUser / imapPassword');
    });

    it('exportSession 在未连接时返回 null', () => {
        const p = new ImapMailProvider({ user: 'a@gmail.com', password: 'p' });
        expect(p.exportSession()).toBeNull();
    });

    it('复用已连接时不重复 connect', async () => {
        const p = new ImapMailProvider({ user: 'a@gmail.com', password: 'p' });
        await p.createAddress();
        expect(mockConnect).toHaveBeenCalledTimes(1);

        // 再次 call getMails 不应再次 connect
        await p.getMails(5);
        expect(mockConnect).toHaveBeenCalledTimes(1);
    });
});
