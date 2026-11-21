/**
 * ImapProvider —— 通用 IMAP 适配器,一套覆盖 Gmail/Outlook/QQ/163/网易等所有支持 IMAP 的邮箱。
 * 用 imapflow 客户端 + mailparser 解析 RFC822。用 UID(而非序号)定位消息,稳定不漂移。
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Credential } from '../../types/credential.js';
import type {
    GetMessageOptions,
    ListOptions,
    ListResult,
    MailProvider,
    MessageUpdate,
    ProviderName,
    SearchQuery,
} from '../../types/provider.js';
import type { AttachmentMeta, Folder, MailAddress, MailMessage } from '../../types/mail.js';
import { AuthError, NetworkError, NotFoundError } from '../../core/errors.js';
import { normalizeDate } from '../../core/date.js';
import { specialUseToRole } from './mailboxMapping.js';

export interface ImapProviderOptions {
    host?: string;
    port?: number;
    /** 默认 true(implicit TLS / IMAPS 993)。 */
    tls?: boolean;
}

const HOST_PRESETS: Record<string, { host: string; port: number }> = {
    'gmail.com': { host: 'imap.gmail.com', port: 993 },
    'googlemail.com': { host: 'imap.gmail.com', port: 993 },
    'outlook.com': { host: 'outlook.office365.com', port: 993 },
    'hotmail.com': { host: 'outlook.office365.com', port: 993 },
    'live.com': { host: 'outlook.office365.com', port: 993 },
    'qq.com': { host: 'imap.qq.com', port: 993 },
    'foxmail.com': { host: 'imap.qq.com', port: 993 },
    '163.com': { host: 'imap.163.com', port: 993 },
    '126.com': { host: 'imap.126.com', port: 993 },
    'yahoo.com': { host: 'imap.mail.yahoo.com', port: 993 },
};

interface ImapEnvelopeAddress {
    name?: string;
    address?: string;
}
interface ImapEnvelope {
    subject?: string;
    from?: ImapEnvelopeAddress[];
    to?: ImapEnvelopeAddress[];
    cc?: ImapEnvelopeAddress[];
    date?: Date;
}
interface ImapFetchItem {
    uid: number;
    envelope?: ImapEnvelope;
    internalDate?: Date;
    flags?: string[];
    source?: Buffer;
}

export class ImapProvider implements MailProvider {
    readonly name: ProviderName = 'imap';
    mailbox = '';

    private client: ImapFlow | null = null;
    private readonly opts: ImapProviderOptions;

    constructor(opts: ImapProviderOptions = {}) {
        this.opts = opts;
    }

    async connect(credential: Credential): Promise<void> {
        if (credential.type !== 'password') {
            throw new AuthError('imap 需要 password 凭据(user / password)');
        }
        const { user, password } = credential;
        const domain = (user.split('@')[1] ?? '').toLowerCase();
        const preset = HOST_PRESETS[domain] ?? { host: '', port: 993 };
        const host = this.opts.host ?? preset.host;
        const port = this.opts.port ?? preset.port;
        if (!host) {
            throw new AuthError(`imap: 无法识别 ${domain} 的服务器,请在 options.host 指定`);
        }

        const client = new ImapFlow({
            host,
            port,
            secure: this.opts.tls !== false,
            auth: { user, pass: password },
            logger: false,
        } as any);
        try {
            await client.connect();
        } catch (e) {
            throw new AuthError(`imap 连接/认证失败 (${host}:${port})`, e);
        }
        this.client = client;
        this.mailbox = user;
    }

    async disconnect(): Promise<void> {
        try {
            await this.client?.logout();
        } catch {
            /* ignore */
        }
        this.client = null;
    }
    isConnected(): boolean {
        return this.client !== null;
    }

    async listFolders(): Promise<readonly Folder[]> {
        this.ensureConnected();
        const list: any[] = (await this.client!.list()) as any[];
        const folders: Folder[] = [];
        for (const item of list) {
            const path: string = item.path ?? item.name ?? '';
            const flags: string[] = item.flags ?? [];
            if (flags.includes('\\Noselect')) continue;
            const specialUse: string | undefined = item.specialUse ?? item.specialuse;
            folders.push({
                id: path,
                name: path,
                displayName: path.split(item.delimiter ?? '/').pop() ?? path,
                specialRole: specialUseToRole(specialUse) ?? (path.toUpperCase() === 'INBOX' ? 'inbox' : undefined),
                selectable: true,
            });
        }
        return folders;
    }

    async listMessages(options?: ListOptions): Promise<ListResult> {
        this.ensureConnected();
        const folder = options?.folderId ?? 'INBOX';
        await this.client!.mailboxOpen(folder);

        const criteria = options?.unreadOnly ? ['UNSEEN'] : ['ALL'];
        const uids: number[] = ((await this.client!.search(criteria as any, { uid: true })) as number[]) ?? [];
        uids.sort((a, b) => a - b);

        const total = uids.length;
        const limit = Math.max(1, options?.limit ?? 20);
        const pageIdx = options?.pageToken ? Number(options.pageToken) : 0;
        // 最新优先:从末尾取 limit 个,翻页向前
        const end = total - pageIdx * limit;
        const start = Math.max(0, end - limit);
        if (end <= 0) return { messages: [] };
        const targetUids = uids.slice(start, end).reverse();

        const messages: MailMessage[] = [];
        for await (const item of this.client!.fetch(targetUids as any, { envelope: true, internalDate: true, flags: true }, { uid: true }) as any) {
            messages.push(this.envelopeToMessage(item as ImapFetchItem, folder));
        }
        const next = start > 0 ? String(pageIdx + 1) : undefined;
        return { messages, nextPageToken: next };
    }

    async getMessage(id: string, opts?: GetMessageOptions): Promise<MailMessage> {
        this.ensureConnected();
        const uid = Number(id);
        const item = (await this.client!.fetchOne(uid, { source: true, envelope: true, internalDate: true, flags: true }, { uid: true })) as any as ImapFetchItem | false;
        if (!item) throw new NotFoundError(`imap: 未找到 uid=${id}`);

        const parsed = await simpleParser(item.source ?? Buffer.from(''));
        const attachments: AttachmentMeta[] = (parsed.attachments ?? []).map((a: { contentId?: string; filename?: string; contentType?: string; size?: number }, i: number) => ({
            id: a.contentId ?? `part-${i}`,
            filename: a.filename ?? 'unknown',
            mimeType: a.contentType ?? 'application/octet-stream',
            size: a.size ?? 0,
        }));

        return {
            id: String(uid),
            providerName: 'imap',
            mailbox: this.mailbox,
            subject: parsed.subject ?? item.envelope?.subject ?? '',
            from: addressFromMailparser(flattenAddressField(parsed.from)),
            to: addressesFromMailparser(flattenAddressField(parsed.to)),
            cc: addressesFromMailparser(flattenAddressField(parsed.cc)),
            date: normalizeDate(parsed.date ?? item.internalDate),
            text: parsed.text ?? undefined,
            html: typeof parsed.html === 'string' ? parsed.html : undefined,
            raw: opts?.fetchRaw ? (item.source?.toString('utf8') ?? undefined) : undefined,
            hasAttachment: attachments.length > 0,
            attachments,
            read: item.flags?.includes('\\Seen') ?? false,
            flags: item.flags ?? [],
            folderId: '',
        };
    }

    async search(query: SearchQuery): Promise<ListResult> {
        this.ensureConnected();
        const folder = query.folderId ?? 'INBOX';
        await this.client!.mailboxOpen(folder);
        const criteria: any[] = [];
        if (query.unreadOnly) criteria.push('UNSEEN');
        if (query.from) criteria.push(['FROM', query.from]);
        if (query.to) criteria.push(['TO', query.to]);
        if (query.subject) criteria.push(['SUBJECT', query.subject]);
        if (query.contains) criteria.push(['BODY', query.contains]);
        if (query.since) criteria.push(['SINCE', new Date(query.since)]);
        if (query.before) criteria.push(['BEFORE', new Date(query.before)]);
        if (criteria.length === 0) criteria.push('ALL');

        const uids: number[] = ((await this.client!.search(criteria as any, { uid: true })) as number[]) ?? [];
        uids.sort((a, b) => b - a); // 新优先
        const limit = query.limit ?? 50;
        const targetUids = uids.slice(0, limit);

        const messages: MailMessage[] = [];
        for await (const item of this.client!.fetch(targetUids as any, { envelope: true, internalDate: true, flags: true }, { uid: true }) as any) {
            messages.push(this.envelopeToMessage(item as ImapFetchItem, folder));
        }
        return { messages };
    }

    async updateMessage(id: string, update: MessageUpdate): Promise<void> {
        this.ensureConnected();
        const uid = Number(id);
        if (update.read === true) {
            await this.client!.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        } else if (update.read === false) {
            await this.client!.messageFlagsRemove(uid, ['\\Seen'], { uid: true });
        }
        if (update.addFlags?.length) {
            await this.client!.messageFlagsAdd(uid, update.addFlags as string[], { uid: true });
        }
        if (update.removeFlags?.length) {
            await this.client!.messageFlagsRemove(uid, update.removeFlags as string[], { uid: true });
        }
    }

    private ensureConnected(): void {
        if (!this.client) throw new NetworkError('imap: 尚未 connect');
    }

    private envelopeToMessage(item: ImapFetchItem, folder: string): MailMessage {
        const env = item.envelope;
        return {
            id: String(item.uid),
            providerName: 'imap',
            mailbox: this.mailbox,
            subject: env?.subject ?? '',
            from: env?.from?.[0]?.address ? { name: env.from[0].name || undefined, address: env.from[0].address } : null,
            to: (env?.to ?? []).filter((a) => a.address).map((a) => ({ address: a.address!, name: a.name || undefined })) as MailAddress[],
            cc: (env?.cc ?? []).filter((a) => a.address).map((a) => ({ address: a.address!, name: a.name || undefined })) as MailAddress[],
            date: normalizeDate(item.internalDate ?? env?.date),
            hasAttachment: false,
            attachments: [],
            read: item.flags?.includes('\\Seen') ?? false,
            flags: item.flags ?? [],
            folderId: folder,
        };
    }
}

/** mailparser 的 from/to/cc 字段可能是 AddressObject 或其数组(分组地址),统一摊平为 value 数组。 */
function flattenAddressField(field: unknown): Array<{ address?: string; name?: string }> {
    const objs = (Array.isArray(field) ? field : field ? [field] : []) as Array<{ value?: unknown }>;
    return objs.flatMap((o) => (Array.isArray(o?.value) ? o.value : [])) as Array<{ address?: string; name?: string }>;
}

function addressFromMailparser(value: unknown): MailAddress | null {
    if (!Array.isArray(value) || value.length === 0) return null;
    const first = value[0] as { address?: string; name?: string };
    return first?.address ? { address: first.address, name: first.name || undefined } : null;
}

function addressesFromMailparser(value: unknown): MailAddress[] {
    if (!Array.isArray(value)) return [];
    return (value as Array<{ address?: string; name?: string }>)
        .filter((v) => v?.address)
        .map((v) => ({ address: v.address!, name: v.name || undefined }));
}
