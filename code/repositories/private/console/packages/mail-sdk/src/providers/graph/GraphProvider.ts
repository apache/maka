/**
 * GraphProvider —— Microsoft Graph API 适配器(Outlook / Hotmail / Live)。
 * OAuth2 认证(由 graphAuth 拿 token),用 @microsoft/microsoft-graph-client 调 REST。
 * 个人 outlook.com 仅支持委派流(authorization_code/device_code),不支持 client_credentials。
 */
import { Client } from '@microsoft/microsoft-graph-client';
import type { Credential, OAuthCredential } from '../../types/credential.js';
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
import { AuthError, NetworkError, UnsupportedError } from '../../core/errors.js';
import { normalizeDate } from '../../core/date.js';
import { getGraphAccessToken } from './graphAuth.js';
import type { GraphProviderOptions } from './graphConfig.js';
export type { GraphProviderOptions };

interface GraphMessage {
    id: string;
    subject?: string;
    from?: { emailAddress?: { name?: string; address?: string } };
    toRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
    receivedDateTime?: string;
    body?: { contentType?: 'text' | 'html'; content?: string };
    bodyPreview?: string;
    isRead?: boolean;
    hasAttachments?: boolean;
}
interface GraphFolder {
    id: string;
    displayName: string;
    totalItemCount?: number;
    unreadItemCount?: number;
    wellKnownName?: string;
}

const SELECT_LIST = 'id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,hasAttachments';
const SELECT_FULL = 'id,subject,from,toRecipients,receivedDateTime,body,isRead,hasAttachments';

function wellKnownToRole(name?: string): SpecialRole | undefined {
    if (!name) return undefined;
    const n = name.toLowerCase();
    if (n.includes('inbox')) return 'inbox';
    if (n.includes('sent')) return 'sent';
    if (n.includes('draft')) return 'drafts';
    if (n.includes('deleted') || n.includes('trash')) return 'trash';
    if (n.includes('junk') || n.includes('spam')) return 'junk';
    if (n.includes('archive')) return 'archive';
    return undefined;
}

export class GraphProvider implements MailProvider {
    readonly name: ProviderName = 'graph';
    mailbox = '';

    private client: Client | null = null;
    private user = 'me';

    constructor(private readonly opts: GraphProviderOptions = {}) {}

    async connect(credential: Credential): Promise<void> {
        if (credential.type !== 'oauth') throw new AuthError('graph 需要 oauth 凭据');
        const oauthCred: OAuthCredential = credential;
        const token = await getGraphAccessToken(oauthCred);
        this.client = Client.init({
            authProvider: (done: (err: Error | null, token: string | null) => void) => done(null, token),
            ...(this.opts.baseUrl ? { baseUrl: this.opts.baseUrl } : {}),
        } as any);
        this.user = this.opts.user ?? oauthCred.delegatedUser ?? this.opts.delegatedUser ?? 'me';
        this.mailbox = this.user === 'me' ? '(me)' : this.user;
    }

    async disconnect(): Promise<void> {
        // Graph 是无状态 HTTP,无连接需关
        this.client = null;
    }
    isConnected(): boolean {
        return this.client !== null;
    }

    async listFolders(): Promise<readonly Folder[]> {
        this.ensureConnected();
        const resp = await this.client!.api(`/users/${this.user}/mailFolders`).get();
        const items: GraphFolder[] = resp.value ?? [];
        return items.map((f) => ({
            id: f.id,
            name: f.displayName,
            displayName: f.displayName,
            specialRole: wellKnownToRole(f.wellKnownName),
            unreadCount: f.unreadItemCount,
            totalCount: f.totalItemCount,
            selectable: true,
        }));
    }

    async listMessages(options?: ListOptions): Promise<ListResult> {
        this.ensureConnected();
        const folder = options?.folderId ?? 'inbox';
        const limit = Math.max(1, options?.limit ?? 20);
        let req = this.client!
            .api(`/users/${this.user}/mailFolders/${folder}/messages`)
            .select(SELECT_LIST)
            .orderby('receivedDateTime desc')
            .top(limit);
        if (options?.unreadOnly) req = req.filter('isRead eq false');
        const resp = await req.get();
        const items: GraphMessage[] = resp.value ?? [];
        const messages = items.map((it) => this.toMessage(it, folder));
        return { messages, nextPageToken: resp['@odata.nextLink'] ?? undefined };
    }

    async getMessage(id: string, _opts?: GetMessageOptions): Promise<MailMessage> {
        this.ensureConnected();
        const resp = (await this.client!
            .api(`/users/${this.user}/messages/${id}`)
            .select(SELECT_FULL)
            .get()) as GraphMessage;
        return this.toMessage(resp, '');
    }

    async search(query: SearchQuery): Promise<ListResult> {
        this.ensureConnected();
        const parts: string[] = [];
        if (query.from) parts.push(`from:${query.from}`);
        if (query.subject) parts.push(`subject:"${query.subject}"`);
        if (query.contains) parts.push(`"${query.contains}"`);
        const q = parts.length > 0 ? parts.join(' AND ') : '*';
        const resp = await this.client!
            .api(`/users/${this.user}/messages`)
            .header('ConsistencyLevel', 'eventual')
            .search(q)
            .top(Math.max(1, query.limit ?? 20))
            .get();
        const items: GraphMessage[] = resp.value ?? [];
        return { messages: items.map((it) => this.toMessage(it, '')) };
    }

    async updateMessage(id: string, update: MessageUpdate): Promise<void> {
        this.ensureConnected();
        if (update.addFlags || update.removeFlags) {
            throw new UnsupportedError('graph 不支持自定义 flags');
        }
        if (update.read !== undefined) {
            await this.client!.api(`/users/${this.user}/messages/${id}`).patch({ isRead: update.read });
        }
    }

    private ensureConnected(): void {
        if (!this.client) throw new NetworkError('graph: 尚未 connect');
    }

    private toMessage(item: GraphMessage, folder: string): MailMessage {
        const from: MailAddress | null = item.from?.emailAddress?.address
            ? { name: item.from.emailAddress.name || undefined, address: item.from.emailAddress.address }
            : null;
        const to: MailAddress[] = (item.toRecipients ?? [])
            .filter((r) => r.emailAddress?.address)
            .map((r) => ({ address: r.emailAddress!.address!, name: r.emailAddress!.name || undefined }));
        const body = item.body;
        return {
            id: item.id,
            providerName: 'graph',
            mailbox: this.mailbox,
            subject: item.subject ?? '',
            from,
            to,
            cc: [],
            date: normalizeDate(item.receivedDateTime),
            text: body?.contentType === 'text' ? body.content : item.bodyPreview,
            html: body?.contentType === 'html' ? body.content : undefined,
            hasAttachment: item.hasAttachments ?? false,
            attachments: [],
            read: item.isRead ?? false,
            flags: [],
            folderId: folder,
        };
    }
}
