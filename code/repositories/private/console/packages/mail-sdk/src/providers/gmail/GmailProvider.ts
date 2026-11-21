/**
 * GmailProvider —— Gmail API 适配器。
 * 用 googleapis 的 gmail_v1。list 用 batchGet + format=metadata 减体积;
 * getMessage 用 format=full(或 fetchRaw 时 format=raw);payload.body.data 是 base64url。
 */
import { google } from 'googleapis';
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
import type { Folder, MailAddress, MailMessage, SpecialRole } from '../../types/mail.js';
import { AuthError, NetworkError } from '../../core/errors.js';
import { normalizeDate } from '../../core/date.js';
import { parseAddressHeader } from '../../core/address.js';
import { decodeBase64Url } from '../../core/decode.js';
import { getGmailAuth } from './gmailAuth.js';
import type { GmailProviderOptions } from './gmailConfig.js';
export type { GmailProviderOptions };

interface GmailMessage {
    id: string;
    threadId?: string;
    labelIds?: string[];
    internalDate?: string;
    payload?: {
        mimeType?: string;
        body?: { data?: string };
        parts?: Array<{ mimeType?: string; filename?: string; body?: { data?: string } }>;
        headers?: Array<{ name: string; value: string }>;
    };
    raw?: string;
}

function extractBody(payload: GmailMessage['payload']): { text?: string; html?: string } {
    if (!payload) return {};
    if (payload.body?.data) {
        const content = decodeBase64Url(payload.body.data);
        return payload.mimeType === 'text/html' ? { html: content } : { text: content };
    }
    let text: string | undefined;
    let html: string | undefined;
    for (const part of payload.parts ?? []) {
        if (part.mimeType === 'text/plain' && part.body?.data && !text) text = decodeBase64Url(part.body.data);
        if (part.mimeType === 'text/html' && part.body?.data && !html) html = decodeBase64Url(part.body.data);
    }
    return { text, html };
}

function labelIdToRole(id?: string): SpecialRole | undefined {
    if (!id) return undefined;
    const i = id.toUpperCase();
    if (i === 'INBOX') return 'inbox';
    if (i === 'SENT') return 'sent';
    if (i === 'DRAFT') return 'drafts';
    if (i === 'TRASH') return 'trash';
    if (i === 'SPAM') return 'junk';
    if (i === 'ALL MAIL' || i === 'STARRED') return 'all';
    return undefined;
}

export class GmailProvider implements MailProvider {
    readonly name: ProviderName = 'gmail';
    mailbox = '';

    private gmail: any = null;
    private user = 'me';

    constructor(private readonly opts: GmailProviderOptions = {}) {}

    async connect(credential: Credential): Promise<void> {
        if (credential.type !== 'oauth') throw new AuthError('gmail 需要 oauth 凭据');
        const auth = getGmailAuth(credential);
        this.gmail = google.gmail({ version: 'v1', auth });
        this.user = this.opts.user ?? credential.delegatedUser ?? 'me';
        this.mailbox = this.user === 'me' ? '(me)' : this.user;
    }

    async disconnect(): Promise<void> {
        this.gmail = null;
    }
    isConnected(): boolean {
        return this.gmail !== null;
    }

    async listFolders(): Promise<readonly Folder[]> {
        this.ensureConnected();
        const resp = await this.gmail.users.labels.list({ userId: this.user });
        const labels: Array<{ id?: string; name?: string }> = resp.data.labels ?? [];
        return labels.map((l) => ({
            id: l.id ?? '',
            name: l.name ?? l.id ?? '',
            displayName: l.name ?? l.id ?? '',
            specialRole: labelIdToRole(l.id),
            selectable: true,
        }));
    }

    async listMessages(options?: ListOptions): Promise<ListResult> {
        this.ensureConnected();
        const labelId = options?.folderId ?? 'INBOX';
        const limit = Math.min(500, Math.max(1, options?.limit ?? 20));
        const listResp = await this.gmail.users.messages.list({
            userId: this.user,
            labelIds: [labelId],
            maxResults: limit,
        });
        const ids: Array<{ id: string }> = listResp.data.messages ?? [];
        if (ids.length === 0) return { messages: [] };

        const batchResp = await this.gmail.users.messages.batchGet({
            userId: this.user,
            ids: ids.map((m) => m.id),
            format: 'metadata',
            metadataHeaders: ['Subject', 'From', 'To', 'Date'],
        });
        let messages = (batchResp.data.messages as GmailMessage[]).map((it) => this.toMessage(it, labelId));
        if (options?.unreadOnly) messages = messages.filter((m) => !m.read);
        return { messages, nextPageToken: listResp.data.nextPageToken ?? undefined };
    }

    async getMessage(id: string, opts?: GetMessageOptions): Promise<MailMessage> {
        this.ensureConnected();
        const resp = await this.gmail.users.messages.get({
            userId: this.user,
            id,
            format: opts?.fetchRaw ? 'raw' : 'full',
        });
        const m = this.toMessage(resp.data as GmailMessage, '');
        if (opts?.fetchRaw && resp.data.raw) {
            return { ...m, raw: decodeBase64Url(resp.data.raw) };
        }
        return m;
    }

    async search(query: SearchQuery): Promise<ListResult> {
        this.ensureConnected();
        const parts: string[] = [];
        if (query.from) parts.push(`from:${query.from}`);
        if (query.to) parts.push(`to:${query.to}`);
        if (query.subject) parts.push(`subject:${query.subject}`);
        if (query.contains) parts.push(`"${query.contains}"`);
        if (query.hasAttachment) parts.push('has:attachment');
        if (query.unreadOnly) parts.push('is:unread');
        if (query.since) parts.push(`after:${query.since.replace(/-/g, '/')}`);
        if (query.before) parts.push(`before:${query.before.replace(/-/g, '/')}`);

        const listResp = await this.gmail.users.messages.list({
            userId: this.user,
            q: parts.join(' '),
            maxResults: Math.max(1, query.limit ?? 20),
        });
        const ids: Array<{ id: string }> = listResp.data.messages ?? [];
        if (ids.length === 0) return { messages: [] };

        const batchResp = await this.gmail.users.messages.batchGet({
            userId: this.user,
            ids: ids.map((m) => m.id),
            format: 'metadata',
            metadataHeaders: ['Subject', 'From', 'To', 'Date'],
        });
        return {
            messages: (batchResp.data.messages as GmailMessage[]).map((it) => this.toMessage(it, '')),
        };
    }

    async updateMessage(id: string, update: MessageUpdate): Promise<void> {
        this.ensureConnected();
        const addLabelIds: string[] = [];
        const removeLabelIds: string[] = [];
        if (update.read === true) removeLabelIds.push('UNREAD');
        else if (update.read === false) addLabelIds.push('UNREAD');
        if (update.addFlags) addLabelIds.push(...update.addFlags);
        if (update.removeFlags) removeLabelIds.push(...update.removeFlags);
        if (addLabelIds.length || removeLabelIds.length) {
            await this.gmail.users.messages.modify({
                userId: this.user,
                id,
                requestBody: { addLabelIds, removeLabelIds },
            });
        }
    }

    private ensureConnected(): void {
        if (!this.gmail) throw new NetworkError('gmail: 尚未 connect');
    }

    private toMessage(msg: GmailMessage, labelId: string): MailMessage {
        const headers: Record<string, string> = {};
        for (const h of msg.payload?.headers ?? []) headers[h.name.toLowerCase()] = h.value;
        const from: MailAddress | null = parseAddressHeader(headers['from'])[0] ?? null;
        const to: MailAddress[] = parseAddressHeader(headers['to']);
        const { text, html } = extractBody(msg.payload);
        const labelIds = msg.labelIds ?? [];
        return {
            id: msg.id,
            providerName: 'gmail',
            mailbox: this.mailbox,
            subject: headers['subject'] ?? '',
            from,
            to,
            cc: [],
            date: normalizeDate(headers['date'] ?? Number(msg.internalDate)),
            text,
            html,
            hasAttachment: (msg.payload?.parts ?? []).some((p) => !!p.filename),
            attachments: [],
            read: !labelIds.includes('UNREAD'),
            flags: labelIds,
            folderId: labelId,
            threadId: msg.threadId,
        };
    }
}
