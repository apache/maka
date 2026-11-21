/**
 * 邮箱验证码提供商抽象接口。
 * 容纳 legacy(自建 Cloudflare temp-mail)和 yyds(商业 API)两种实现。
 * session 导出/复用:第一次注册时 exportSession 存盘,resume 模式用 useExistingAddressSession 恢复同一临时邮箱。
 */
import type { Email } from '../../types/brand.js';

export type MailProviderName = 'legacy' | 'yyds' | 'imap' | 'cdk';

export interface MailSession {
    readonly provider: MailProviderName;
    readonly address: Email;
    /** legacy 用。 */
    readonly jwt?: string;
    readonly addressId?: string | number;
    /** yyds 用。 */
    readonly tempToken?: string;
    readonly accountId?: string;
    /** imap 用。注意:明文存储,请确保数据库文件安全。 */
    readonly imapUser?: string;
    readonly imapPassword?: string;
    readonly imapHost?: string;
    readonly imapPort?: number;
    /** cdk 用(CDK API 兑换的 Outlook 邮箱)。 */
    readonly cdkKey?: string;
    readonly cdkApiBase?: string;
}

export interface CreatedAddress {
    readonly address: Email;
    readonly session: MailSession;
}

export interface MailMessage {
    readonly id?: string;
    readonly subject?: string;
    readonly from?: unknown;
    readonly to?: unknown[];
    readonly createdAt?: string;
    readonly text?: string;
    readonly html?: string;
    readonly raw?: string;
}

export interface MailProvider {
    readonly name: MailProviderName;
    /** 创建新邮箱(name 为空则随机)。 */
    createAddress(name?: string): Promise<CreatedAddress>;
    /** 复用已有会话(resume / phase8)。 */
    useExistingAddressSession(session: MailSession): void;
    /** 当前邮箱地址(可能 null)。 */
    getEmail(): Email | null;
    /** 收件箱 URL(legacy 用;yyds 无浏览器收件箱返回 null)。 */
    getInboxUrl(): string | null;
    /** 拉取当前会话邮件。 */
    getMails(limit?: number, offset?: number): Promise<MailMessage[]>;
    /** 拉取指定地址邮件(跨账号 resume)。 */
    getMailsByAddress(address: Email, limit?: number, offset?: number): Promise<MailMessage[]>;
    /** 导出会话以便持久化。 */
    exportSession(): MailSession | null;
}
