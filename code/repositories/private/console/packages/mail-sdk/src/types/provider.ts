/**
 * MailProvider 核心接口:四个适配器的统一契约。
 * 生命周期:connect() 一次 → 多次 list/get/search → disconnect()。
 */
import type { Folder, MailMessage } from './mail.js';
import type { Credential } from './credential.js';

export type ProviderName = 'imap' | 'graph' | 'gmail' | 'tempmail';

export interface ListOptions {
    readonly folderId?: string;
    readonly limit?: number;
    readonly pageToken?: string;
    readonly unreadOnly?: boolean;
}

export interface ListResult {
    readonly messages: readonly MailMessage[];
    readonly nextPageToken?: string;
}

export interface SearchQuery {
    readonly folderId?: string;
    readonly from?: string;
    readonly to?: string;
    readonly subject?: string;
    readonly contains?: string;
    readonly since?: string;
    readonly before?: string;
    readonly hasAttachment?: boolean;
    readonly unreadOnly?: boolean;
    readonly limit?: number;
    readonly pageToken?: string;
}

export interface MessageUpdate {
    readonly read?: boolean;
    readonly addFlags?: readonly string[];
    readonly removeFlags?: readonly string[];
}

export interface GetMessageOptions {
    readonly fetchRaw?: boolean;
}

export interface MailProvider {
    readonly name: ProviderName;
    /** 当前连接的邮箱地址(connect 后非空)。 */
    readonly mailbox: string;

    connect(credential: Credential): Promise<void>;
    disconnect(): Promise<void>;
    isConnected(): boolean;

    listFolders(): Promise<readonly Folder[]>;
    listMessages(options?: ListOptions): Promise<ListResult>;
    getMessage(id: string, opts?: GetMessageOptions): Promise<MailMessage>;
    search(query: SearchQuery): Promise<ListResult>;

    /** 可选:标记已读/未读/加 flag。不支持者不实现(用 'updateMessage' in provider 判定)。 */
    updateMessage?(id: string, update: MessageUpdate): Promise<void>;
}
