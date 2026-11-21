/**
 * IMAP 外部邮箱桥接适配器。
 * 实现 account-registration-script 的 MailProvider 接口,内部委派给 mail-sdk 的 ImapProvider。
 * 用于将已有邮箱(Gmail/Outlook/Yahoo/QQ/163 等)接入注册流程收验证码。
 *
 * 与 LegacyMailProvider 的关键区别:
 * - 不创建临时邮箱,而是用已有邮箱的 IMAP 凭据连接
 * - createAddress() 验证连通性后返回预配置地址
 * - getInboxUrl() 返回 null(IMAP 无浏览器收件箱)
 * - MailSession 存储 imapUser/imapPassword 用于 resume 恢复
 */
import { ImapProvider } from '@ggbdpq/mail-sdk';
import type { PasswordCredential } from '@ggbdpq/mail-sdk';
import type { Email } from '../../types/brand.js';
import { asEmail } from '../../types/brand.js';
import type { CreatedAddress, MailMessage, MailProvider, MailSession } from './MailProvider.js';

export interface ImapMailProviderOptions {
    readonly user: string;
    readonly password: string;
    readonly host?: string;
    readonly port?: number;
    readonly tls?: boolean;
}

export class ImapMailProvider implements MailProvider {
    readonly name = 'imap' as const;

    private imapProvider: ImapProvider;
    private address: Email | null = null;
    private connected = false;

    constructor(private readonly opts: ImapMailProviderOptions) {
        if (!opts.user || !opts.password) {
            throw new Error('ImapMailProvider: user / password 必填');
        }
        this.imapProvider = new ImapProvider({
            host: opts.host || undefined,
            port: opts.port,
            tls: opts.tls,
        });
    }

    async createAddress(_name?: string): Promise<CreatedAddress> {
        await this.ensureConnected();
        const session = this.exportSession();
        if (!session) throw new Error('ImapMailProvider.createAddress: 创建后无会话');
        return { address: this.address!, session };
    }

    useExistingAddressSession(session: MailSession): void {
        if (!session.imapUser || !session.imapPassword) {
            throw new Error('ImapMailProvider.useExistingAddressSession: 会话缺少 imapUser / imapPassword');
        }
        this.address = asEmail(session.address);

        // 如果当前 provider 已连接且地址相同,则不重建连接
        if (this.connected && this.address === this.opts.user) return;

        // 从 session 重建 provider(host/port 可能不同于配置时的值)
        this.connected = false;
        this.imapProvider = new ImapProvider({
            host: session.imapHost || undefined,
            port: session.imapPort,
            tls: true,
        });
        // 用 session 中的凭据覆盖 opts(用于后续 ensureConnected)
        (this.opts as { user: string; password: string }).user = session.imapUser;
        (this.opts as { user: string; password: string }).password = session.imapPassword;
    }

    getEmail(): Email | null {
        return this.address;
    }

    getInboxUrl(): string | null {
        return null; // IMAP 无浏览器收件箱
    }

    async getMails(limit = 10, _offset = 0): Promise<MailMessage[]> {
        await this.ensureConnected();
        const result = await this.imapProvider.search({
            folderId: 'INBOX',
            limit,
        });
        return result.messages.map((m) => this.adaptMessage(m));
    }

    async getMailsByAddress(address: Email, limit = 10, offset = 0): Promise<MailMessage[]> {
        if (this.address === address) return this.getMails(limit, offset);
        throw new Error(`ImapMailProvider.getMailsByAddress: 无 ${address} 的会话(需先 useExistingAddressSession)`);
    }

    exportSession(): MailSession | null {
        if (!this.address) return null;
        return {
            provider: 'imap',
            address: this.address,
            imapUser: this.opts.user,
            imapPassword: this.opts.password,
            imapHost: this.opts.host,
            imapPort: this.opts.port,
        };
    }

    /** 惰性连接:首次调用时才执行 IMAP 认证,避免构造即联网。 */
    private async ensureConnected(): Promise<void> {
        if (this.connected && this.imapProvider.isConnected()) return;

        const credential: PasswordCredential = {
            type: 'password',
            user: this.opts.user,
            password: this.opts.password,
        };
        await this.imapProvider.connect(credential);
        this.address = asEmail(this.opts.user);
        this.connected = true;
    }

    /**
     * 将 mail-sdk 的 MailMessage 适配为 account-registration-script 的 MailMessage。
     * mail-sdk 字段更丰富(mailbox/providerName/flags/attachments 等),
     * 此处只提取注册流程需要的字段。
     */
    private adaptMessage(m: {
        id: string;
        subject?: string;
        from?: { address: string; name?: string } | null;
        to?: readonly { address: string; name?: string }[];
        date?: string;
        text?: string;
        html?: string;
        raw?: string;
    }): MailMessage {
        return {
            id: m.id,
            subject: m.subject ?? '',
            from: m.from ?? undefined,
            to: m.to ? [...m.to] : undefined,
            createdAt: m.date,
            text: m.text,
            html: m.html,
            raw: m.raw,
        };
    }
}
