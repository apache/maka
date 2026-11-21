/**
 * 邮件领域模型:四个适配器(IMAP/Graph/Gmail/temp-mail)字段的归一并集。
 * 所有适配器产出的数据都映射到这些类型,调用方无需关心来源协议。
 */

export interface MailAddress {
    /** 显示名(如 "GitHub");无则 undefined(不返回空串)。 */
    readonly name?: string;
    /** 规范小写邮箱地址。 */
    readonly address: string;
}

export interface AttachmentMeta {
    readonly id: string;
    readonly filename: string;
    readonly mimeType: string;
    readonly size: number;
}

/** 统一邮件。可选字段以 undefined 表示"该 provider 未提供"。 */
export interface MailMessage {
    readonly id: string;
    readonly providerName: string;
    readonly mailbox: string;

    readonly subject: string;
    readonly from: MailAddress | null;
    readonly to: readonly MailAddress[];
    readonly cc: readonly MailAddress[];
    /** ISO 8601 UTC 字符串(已归一)。 */
    readonly date: string;

    readonly text?: string;
    readonly html?: string;
    readonly raw?: string;

    readonly hasAttachment: boolean;
    readonly attachments: readonly AttachmentMeta[];
    readonly read: boolean;
    readonly flags: readonly string[];
    readonly folderId: string;
    readonly threadId?: string;
}

export type SpecialRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'all';

export interface Folder {
    readonly id: string;
    readonly name: string;
    readonly displayName: string;
    readonly specialRole?: SpecialRole;
    readonly unreadCount?: number;
    readonly totalCount?: number;
    readonly selectable: boolean;
}
