import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock imapflow:ImapFlow 构造返回一个可控的客户端实例
vi.mock('imapflow', () => {
    const ImapFlow = vi.fn(function (this: any, opts: unknown) {
        this.opts = opts;
        this.connect = vi.fn(async () => {});
        this.logout = vi.fn(async () => {});
        this.list = vi.fn(async () => [
            { path: 'INBOX', specialUse: '\\Inbox', flags: [], delimiter: '.' },
            { path: 'Sent', specialUse: '\\Sent', flags: [], delimiter: '.' },
            { path: 'Drafts', specialUse: '\\Drafts', flags: [], delimiter: '.' },
            { path: 'NoSelect', flags: ['\\Noselect'], delimiter: '.' },
        ]);
        this.mailboxOpen = vi.fn(async () => ({ exists: 0 }));
        this.search = vi.fn(async () => []);
        this.fetch = async function* () {
            /* 默认空 */
        };
        this.fetchOne = vi.fn(async () => false);
        this.messageFlagsAdd = vi.fn(async () => {});
        this.messageFlagsRemove = vi.fn(async () => {});
    });
    return { ImapFlow };
});

// mock mailparser 的 simpleParser
vi.mock('mailparser', () => ({
    simpleParser: vi.fn(async () => ({
        subject: 'Parsed subject',
        from: { value: [{ address: 'sender@example.com', name: 'Sender' }] },
        to: { value: [{ address: 'me@example.com' }] },
        text: 'plain body',
        html: '<p>html body</p>',
        date: new Date('2024-01-14T00:00:00Z'),
        attachments: [],
    })),
}));

import { ImapFlow } from 'imapflow';
import { ImapProvider } from '../../src/providers/imap/ImapProvider.js';
import { AuthError } from '../../src/core/errors.js';

function lastImapOpts(): Record<string, unknown> {
    const calls = (ImapFlow as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    return (calls[calls.length - 1]?.[0] ?? {}) as Record<string, unknown>;
}

describe('ImapProvider', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('connect:Gmail 用户自动用 imap.gmail.com:993 预设', async () => {
        const p = new ImapProvider();
        await p.connect({ type: 'password', user: 'me@gmail.com', password: 'app-pass' });
        const opts = lastImapOpts();
        expect(opts.host).toBe('imap.gmail.com');
        expect(opts.port).toBe(993);
        expect(opts.secure).toBe(true);
        expect(p.mailbox).toBe('me@gmail.com');
    });

    it('connect:QQ 用户用 imap.qq.com 预设', async () => {
        const p = new ImapProvider();
        await p.connect({ type: 'password', user: '12345@qq.com', password: 'authcode' });
        expect(lastImapOpts().host).toBe('imap.qq.com');
    });

    it('connect:options.host 覆盖预设', async () => {
        const p = new ImapProvider({ host: 'mail.custom.com', port: 143 });
        await p.connect({ type: 'password', user: 'a@custom.com', password: 'p' });
        expect(lastImapOpts().host).toBe('mail.custom.com');
        expect(lastImapOpts().port).toBe(143);
    });

    it('connect:非 password 凭据抛 AuthError', async () => {
        const p = new ImapProvider();
        await expect(
            p.connect({ type: 'anonymous' } as never),
        ).rejects.toBeInstanceOf(AuthError);
    });

    it('listFolders:映射 specialUse + 过滤 Noselect', async () => {
        const p = new ImapProvider();
        await p.connect({ type: 'password', user: 'a@gmail.com', password: 'p' });
        const folders = await p.listFolders();
        const ids = folders.map((f) => f.id);
        expect(ids).toEqual(['INBOX', 'Sent', 'Drafts']); // NoSelect 被过滤
        expect(folders.find((f) => f.id === 'INBOX')?.specialRole).toBe('inbox');
        expect(folders.find((f) => f.id === 'Sent')?.specialRole).toBe('sent');
        expect(folders.find((f) => f.id === 'Drafts')?.specialRole).toBe('drafts');
    });

    it('isConnected:connect 前 false,connect 后 true', async () => {
        const p = new ImapProvider();
        expect(p.isConnected()).toBe(false);
        await p.connect({ type: 'password', user: 'a@gmail.com', password: 'p' });
        expect(p.isConnected()).toBe(true);
    });
});
