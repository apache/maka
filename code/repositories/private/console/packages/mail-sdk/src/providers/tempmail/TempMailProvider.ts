/**
 * TempMailProvider —— 对接 mail.tm 公开临时邮箱 API。
 * 无需自有账号:connect 时创建一次性邮箱 + 拿 JWT(强制认证享配额)。
 * 文件夹固定为 inbox;search 客户端内存过滤(mail.tm 不支持服务端搜索)。
 */
import axios, { type AxiosInstance } from 'axios';
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
import type { Folder, MailAddress, MailMessage } from '../../types/mail.js';
import { AuthError, NetworkError, UnsupportedError } from '../../core/errors.js';
import { normalizeDate } from '../../core/date.js';

const DEFAULT_BASE = 'https://api.mail.tm';

export interface TempMailProviderOptions {
    baseUrl?: string;
    domain?: string;
    httpClient?: AxiosInstance;
}

interface MailTmMessageItem {
    id: string;
    from?: { address?: string; name?: string };
    to?: Array<{ address?: string; name?: string }> | { address?: string; name?: string };
    subject?: string;
    intro?: string;
    text?: string;
    html?: string[] | string;
    seen?: boolean;
    hasAttachments?: boolean;
    createdAt?: string;
}

const randomPrefix = (): string => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 10; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return `sdk-${s}`;
};
const randomPassword = (): string => {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    let s = '';
    for (let i = 0; i < 16; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return `${s}!1`;
};

export class TempMailProvider implements MailProvider {
    readonly name: ProviderName = 'tempmail';
    mailbox = '';

    private readonly http: AxiosInstance;
    private token: string | null = null;

    constructor(private readonly opts: TempMailProviderOptions = {}) {
        this.http = opts.httpClient ?? axios.create({ baseURL: opts.baseUrl ?? DEFAULT_BASE, timeout: 15_000 });
    }

    private authHeader(): Record<string, string> {
        if (!this.token) throw new AuthError('tempmail: 尚未 connect(无 token)');
        return { Authorization: `Bearer ${this.token}` };
    }

    async connect(credential: Credential): Promise<void> {
        if (credential.type !== 'anonymous') {
            throw new AuthError('tempmail 仅支持 anonymous 凭据');
        }
        // 已有 token:直接复用
        if (credential.token) {
            this.token = credential.token;
            this.mailbox = await this.fetchMyAddress();
            return;
        }
        // 创建新临时邮箱
        const domain = this.opts.domain ?? (await this.pickDomain());
        const prefix = credential.addressPrefix ?? randomPrefix();
        const address = `${prefix}@${domain}`;
        const password = randomPassword();
        try {
            await this.http.post('/accounts', { address, password });
        } catch (e) {
            throw new NetworkError(`tempmail: 创建临时邮箱失败 (${address})`, e);
        }
        let tokenResp: { token: string; id: string };
        try {
            const r = await this.http.post('/token', { address, password });
            tokenResp = r.data as { token: string; id: string };
        } catch (e) {
            throw new AuthError('tempmail: 获取 token 失败', e);
        }
        this.token = tokenResp.token;
        this.mailbox = address;
    }

    async disconnect(): Promise<void> {
        this.token = null;
    }
    isConnected(): boolean {
        return this.token !== null;
    }

    async listFolders(): Promise<readonly Folder[]> {
        return [
            {
                id: 'inbox',
                name: 'INBOX',
                displayName: 'INBOX',
                specialRole: 'inbox',
                selectable: true,
            },
        ];
    }

    async listMessages(options?: ListOptions): Promise<ListResult> {
        const page = options?.pageToken ? Number(options.pageToken) : 1;
        const resp = await this.http.get('/messages', { params: { page }, headers: this.authHeader() });
        const items: MailTmMessageItem[] = resp.data?.['hydra:member'] ?? [];
        let messages = items.map((it) => this.toMessage(it));
        if (options?.unreadOnly) messages = messages.filter((m) => !m.read);
        const limited = options?.limit ? messages.slice(0, options.limit) : messages;
        const next = items.length >= 20 ? String(page + 1) : undefined;
        return { messages: limited, nextPageToken: next };
    }

    async getMessage(id: string, opts?: GetMessageOptions): Promise<MailMessage> {
        const resp = await this.http.get(`/messages/${id}`, { headers: this.authHeader() });
        const base = this.toMessage(resp.data as MailTmMessageItem);
        if (opts?.fetchRaw) {
            try {
                const src = await this.http.get(`/messages/${id}/source`, { headers: this.authHeader() });
                const raw = typeof src.data === 'string' ? src.data : (src.data?.data ?? JSON.stringify(src.data));
                return { ...base, raw };
            } catch {
                /* raw 可选,失败忽略 */
            }
        }
        return base;
    }

    async search(query: SearchQuery): Promise<ListResult> {
        // mail.tm 不支持服务端搜索:拉取最多 5 页客户端过滤
        const collected: MailMessage[] = [];
        for (let page = 1; page <= 5; page++) {
            const resp = await this.http.get('/messages', { params: { page }, headers: this.authHeader() });
            const items: MailTmMessageItem[] = resp.data?.['hydra:member'] ?? [];
            if (items.length === 0) break;
            collected.push(...items.map((it) => this.toMessage(it)));
        }
        const filtered = collected.filter((m) => matches(m, query));
        const limited = query.limit ? filtered.slice(0, query.limit) : filtered;
        return { messages: limited };
    }

    async updateMessage(id: string, update: MessageUpdate): Promise<void> {
        if (update.addFlags || update.removeFlags) {
            throw new UnsupportedError('tempmail 不支持 flags 修改');
        }
        if (update.read !== undefined) {
            await this.http.patch(`/messages/${id}`, { seen: update.read }, { headers: this.authHeader() });
        }
    }

    private async pickDomain(): Promise<string> {
        const resp = await this.http.get('/domains');
        const items: Array<{ domain: string }> = resp.data?.['hydra:member'] ?? resp.data ?? [];
        if (items.length === 0) throw new NetworkError('tempmail: 无可用域名');
        return items[Math.floor(Math.random() * items.length)]!.domain;
    }

    private async fetchMyAddress(): Promise<string> {
        const resp = await this.http.get('/me', { headers: this.authHeader() });
        return (resp.data?.address as string) ?? '';
    }

    private toMessage(item: MailTmMessageItem): MailMessage {
        const from: MailAddress | null = item.from?.address
            ? { name: item.from.name || undefined, address: item.from.address }
            : null;
        const toArray: MailAddress[] = Array.isArray(item.to)
            ? (item.to.filter((t) => t?.address).map((t) => ({ address: t.address!, name: t.name || undefined })) as MailAddress[])
            : item.to?.address
              ? [{ address: item.to.address }]
              : [];
        const html = Array.isArray(item.html) ? item.html.join('\n') : item.html;
        return {
            id: item.id,
            providerName: 'tempmail',
            mailbox: this.mailbox,
            subject: item.subject ?? '',
            from,
            to: toArray,
            cc: [],
            date: normalizeDate(item.createdAt),
            text: item.text,
            html,
            hasAttachment: item.hasAttachments ?? false,
            attachments: [],
            read: item.seen === true,
            flags: [],
            folderId: 'inbox',
        };
    }
}

function matches(m: MailMessage, q: SearchQuery): boolean {
    if (q.unreadOnly && m.read) return false;
    if (q.from && !(m.from?.address.includes(q.from.toLowerCase()) || (m.from?.name ?? '').toLowerCase().includes(q.from.toLowerCase()))) return false;
    if (q.subject && !m.subject.toLowerCase().includes(q.subject.toLowerCase())) return false;
    if (q.contains && !(m.text ?? '').toLowerCase().includes(q.contains.toLowerCase())) return false;
    if (q.hasAttachment && !m.hasAttachment) return false;
    if (q.since && m.date < normalizeDate(q.since)) return false;
    if (q.before && m.date >= normalizeDate(q.before)) return false;
    return true;
}
