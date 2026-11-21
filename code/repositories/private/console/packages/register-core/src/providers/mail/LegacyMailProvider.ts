/**
 * legacy 邮箱实现(自建 Cloudflare Workers temp-mail 后端)。
 * 迁移自现有 mailProvider.js 核心方法,改造:TS 类型、HTTP 客户端注入、品牌类型。
 * 核心方法完整迁移;admin 多端点兜底反查(admin 反查 7 端点 + 列信 6 端点)留作 TODO 增量。
 */
import { randomInt } from 'node:crypto';
import type { AxiosInstance } from 'axios';
import { asEmail, type Email } from '../../types/brand.js';
import { createHttpClient } from '../../infra/http.js';
import type { CreatedAddress, MailMessage, MailProvider, MailSession } from './MailProvider.js';

export interface LegacyMailProviderOptions {
    baseUrl: string;
    adminPassword: string;
    sitePassword?: string;
    domain: string;
    httpClient?: AxiosInstance;
}

interface NewAddressResponse {
    jwt: string;
    address: string;
    address_id: string | number;
}

export class LegacyMailProvider implements MailProvider {
    readonly name = 'legacy' as const;
    private readonly http: AxiosInstance;
    private jwt: string | null = null;
    private address: Email | null = null;
    private addressId: string | number | null = null;

    constructor(private readonly opts: LegacyMailProviderOptions) {
        if (!opts.baseUrl || !opts.adminPassword || !opts.domain) {
            throw new Error('LegacyMailProvider: baseUrl / adminPassword / domain 必填');
        }
        this.http = opts.httpClient ?? createHttpClient({ baseURL: opts.baseUrl, timeoutMs: 15_000 });
    }

    private adminHeaders(): Record<string, string> {
        const h: Record<string, string> = { 'Content-Type': 'application/json', 'x-admin-auth': this.opts.adminPassword };
        if (this.opts.sitePassword) h['x-custom-auth'] = this.opts.sitePassword;
        return h;
    }

    private addressHeaders(): Record<string, string> {
        const h: Record<string, string> = { Authorization: `Bearer ${this.jwt ?? ''}` };
        if (this.opts.sitePassword) h['x-custom-auth'] = this.opts.sitePassword;
        return h;
    }

    private randomName(): string {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        const len = 8 + randomInt(5);
        let s = '';
        for (let i = 0; i < len; i++) s += chars[randomInt(chars.length)];
        return s;
    }

    async createAddress(name?: string): Promise<CreatedAddress> {
        const emailName = name ?? this.randomName();
        const resp = await this.http.post(
            '/admin/new_address',
            { name: emailName, domain: this.opts.domain, enablePrefix: false },
            { headers: this.adminHeaders() },
        );
        const d = resp.data as NewAddressResponse;
        this.jwt = d.jwt;
        this.address = asEmail(d.address);
        this.addressId = d.address_id;
        const session = this.exportSession();
        if (!session) throw new Error('LegacyMailProvider.createAddress: 创建后无会话');
        return { address: this.address, session };
    }

    useExistingAddressSession(session: MailSession): void {
        if (!session.address || !session.jwt) {
            throw new Error('LegacyMailProvider.useExistingAddressSession: 会话缺少 address / jwt');
        }
        this.address = asEmail(session.address);
        this.jwt = session.jwt;
        this.addressId = session.addressId ?? null;
    }

    getEmail(): Email | null {
        return this.address;
    }

    getInboxUrl(): string | null {
        if (!this.jwt) return null;
        return `${this.opts.baseUrl}/?jwt=${this.jwt}`;
    }

    async getMails(limit = 10, offset = 0): Promise<MailMessage[]> {
        if (!this.jwt) throw new Error('LegacyMailProvider.getMails: 无活跃会话');
        const resp = await this.http.get('/api/mails', { params: { limit, offset }, headers: this.addressHeaders() });
        const results = (resp.data as { results?: MailMessage[] }).results ?? [];
        return results;
    }

    async getMailsByAddress(address: Email, limit = 10, offset = 0): Promise<MailMessage[]> {
        if (this.address && this.address === address) return this.getMails(limit, offset);
        // TODO(Phase 2+): 迁移现有 admin 多端点兜底(_tryFetchSessionByAdmin / _fetchMailsByAdmin)。
        // 当前仅支持当前会话邮箱;跨账号 resume 请先用 useExistingAddressSession 注入 session。
        throw new Error(`LegacyMailProvider.getMailsByAddress: 无 ${address} 的会话(需先 useExistingAddressSession)`);
    }

    exportSession(): MailSession | null {
        if (!this.address || !this.jwt) return null;
        return {
            provider: 'legacy',
            address: this.address,
            jwt: this.jwt,
            addressId: this.addressId ?? undefined,
        };
    }
}
