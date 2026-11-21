/**
 * MockMailProvider:脚本化的 MailProvider 实现,供聚合层测试与接口契约验证。
 * 构造时注入 folders/messages,可注入故障模式(setFailure)。
 */
import type {
    GetMessageOptions,
    ListOptions,
    ListResult,
    MailProvider,
    MessageUpdate,
    ProviderName,
    SearchQuery,
} from '../../src/types/provider.js';
import type { Folder, MailMessage } from '../../src/types/mail.js';

export interface MockMailProviderOptions {
    readonly name?: ProviderName;
    readonly mailbox: string;
    readonly folders?: readonly Folder[];
    readonly messages?: readonly MailMessage[];
}

export class MockMailProvider implements MailProvider {
    readonly name: ProviderName;
    mailbox: string;
    private connected = false;
    private readonly folders: Folder[];
    private messages: MailMessage[];
    private readonly failures: Partial<Record<'listMessages' | 'search', Error>> = {};

    constructor(opts: MockMailProviderOptions) {
        this.name = opts.name ?? 'tempmail';
        this.mailbox = opts.mailbox;
        this.folders = [...(opts.folders ?? [])];
        this.messages = [...(opts.messages ?? [])];
    }

    async connect(): Promise<void> {
        this.connected = true;
    }
    async disconnect(): Promise<void> {
        this.connected = false;
    }
    isConnected(): boolean {
        return this.connected;
    }

    setFailure(method: 'listMessages' | 'search', err: Error): void {
        this.failures[method] = err;
    }

    async listFolders(): Promise<readonly Folder[]> {
        return [...this.folders];
    }

    async listMessages(options?: ListOptions): Promise<ListResult> {
        if (this.failures.listMessages) throw this.failures.listMessages;
        let msgs = [...this.messages].sort((a, b) => b.date.localeCompare(a.date));
        if (options?.folderId) msgs = msgs.filter((m) => m.folderId === options.folderId);
        if (options?.unreadOnly) msgs = msgs.filter((m) => !m.read);
        const limit = options?.limit ?? msgs.length;
        return { messages: msgs.slice(0, Math.max(0, limit)) };
    }

    async getMessage(id: string, _opts?: GetMessageOptions): Promise<MailMessage> {
        const m = this.messages.find((x) => x.id === id);
        if (!m) throw new Error(`MockMailProvider: 未找到 ${id}`);
        return m;
    }

    async search(query: SearchQuery): Promise<ListResult> {
        if (this.failures.search) throw this.failures.search;
        let msgs = [...this.messages];
        if (query.folderId) {
            const folderId = query.folderId;
            msgs = msgs.filter((m) => m.folderId === folderId);
        }
        if (query.from) {
            const from = query.from.toLowerCase();
            msgs = msgs.filter((m) => m.from?.address.includes(from));
        }
        if (query.subject) {
            const subject = query.subject.toLowerCase();
            msgs = msgs.filter((m) => m.subject.toLowerCase().includes(subject));
        }
        if (query.unreadOnly) msgs = msgs.filter((m) => !m.read);
        msgs.sort((a, b) => b.date.localeCompare(a.date));
        return { messages: query.limit ? msgs.slice(0, query.limit) : msgs };
    }

    async updateMessage(id: string, update: MessageUpdate): Promise<void> {
        const idx = this.messages.findIndex((x) => x.id === id);
        if (idx >= 0 && update.read !== undefined) {
            this.messages[idx] = { ...this.messages[idx]!, read: update.read };
        }
    }
}

/** 构造测试用 MailMessage(补全默认字段)。 */
export function makeMockMessage(partial: Partial<MailMessage> & { id: string; date: string }): MailMessage {
    return {
        providerName: 'tempmail',
        mailbox: '',
        subject: '',
        from: null,
        to: [],
        cc: [],
        hasAttachment: false,
        attachments: [],
        read: false,
        flags: [],
        folderId: 'inbox',
        ...partial,
    };
}
