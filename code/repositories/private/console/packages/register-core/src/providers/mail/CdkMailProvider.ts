/**
 * CDK API 邮箱桥接适配器。
 * 实现 account-registration-script 的 MailProvider 接口,通过 CDK API 获取已兑换的 Outlook 邮箱邮件。
 *
 * 与 LegacyMailProvider / ImapMailProvider 的关键区别:
 * - 无需创建邮箱或 IMAP 连接,直接用 cdkKey 调 HTTP API 取信
 * - createAddress() 无网络调用,直接返回配置的邮箱地址
 * - getMails() 调用 GET /api/email?cdkey=xxx,返回最新邮件
 * - getInboxUrl() 返回 null(纯 API,无浏览器收件箱)
 *
 * API 格式(CDK 兑换后):
 *   GET https://cdk.hhnto.top/api/email?cdkey=Mail-xxx
 *   → { status: "success", subject, from, body, received_at }
 */
import type { Email } from '../../types/brand.js';
import { asEmail } from '../../types/brand.js';
import { createHttpClient } from '../../infra/http.js';
import type { AxiosInstance } from 'axios';
import type { CreatedAddress, MailMessage, MailProvider, MailSession } from './MailProvider.js';

export interface CdkMailProviderOptions {
    /** CDK 兑换码,如 Mail-82621d2b42074af8ba17dc007。 */
    readonly cdkKey: string;
    /** CDK 兑换得到的 Outlook 邮箱地址。 */
    readonly email: string;
    /** API 基础地址,默认 https://cdk.hhnto.top。 */
    readonly apiBaseUrl?: string;
    /** 可注入的 HTTP 客户端(测试用)。 */
    readonly httpClient?: AxiosInstance;
}

/** CDK API 返回的邮件格式。 */
interface CdkApiResponse {
    status: string;
    subject?: string;
    from?: string;
    body?: string;
    received_at?: string;
}

export class CdkMailProvider implements MailProvider {
    readonly name = 'cdk' as const;

    private readonly http: AxiosInstance;
    private address: Email | null = null;

    constructor(private readonly opts: CdkMailProviderOptions) {
        if (!opts.cdkKey || !opts.email) {
            throw new Error('CdkMailProvider: cdkKey / email 必填');
        }
        this.http =
            opts.httpClient ??
            createHttpClient({ baseURL: opts.apiBaseUrl ?? 'https://cdk.hhnto.top', timeoutMs: 15_000 });
    }

    async createAddress(_name?: string): Promise<CreatedAddress> {
        this.address = asEmail(this.opts.email);
        const session = this.exportSession();
        if (!session) throw new Error('CdkMailProvider.createAddress: 配置有误,无会话');
        return { address: this.address, session };
    }

    useExistingAddressSession(session: MailSession): void {
        if (!session.cdkKey || !session.address) {
            throw new Error('CdkMailProvider.useExistingAddressSession: 会话缺少 cdkKey / address');
        }
        this.address = asEmail(session.address);
        // 用 session 中的值覆盖构造时的 opts(用于后续 getMails)
        (this.opts as { cdkKey: string }).cdkKey = session.cdkKey;
        (this.opts as { email: string }).email = session.address;
    }

    getEmail(): Email | null {
        return this.address;
    }

    getInboxUrl(): string | null {
        return null; // 纯 API,无浏览器收件箱
    }

    async getMails(_limit?: number, _offset?: number): Promise<MailMessage[]> {
        if (!this.opts.cdkKey) {
            throw new Error('CdkMailProvider.getMails: 无 cdkKey');
        }

        const resp = await this.http.get('/api/email', { params: { cdkey: this.opts.cdkKey } });
        const data = resp.data as CdkApiResponse;

        if (!data || data.status === 'error') return [];

        return [this.adaptResponse(data)];
    }

    async getMailsByAddress(address: Email, limit?: number, offset?: number): Promise<MailMessage[]> {
        if (this.address === address) return this.getMails(limit, offset);
        throw new Error(`CdkMailProvider.getMailsByAddress: 无 ${address} 的会话(需先 useExistingAddressSession)`);
    }

    exportSession(): MailSession | null {
        if (!this.address) return null;
        return {
            provider: 'cdk',
            address: this.address,
            cdkKey: this.opts.cdkKey,
            cdkApiBase: this.opts.apiBaseUrl,
        };
    }

    /** 将 CDK API 响应适配为 account-registration-script 的 MailMessage。 */
    private adaptResponse(data: CdkApiResponse): MailMessage {
        const fromAddr = data.from ?? '';
        return {
            subject: data.subject ?? '',
            from: fromAddr ? { address: fromAddr } : undefined,
            text: data.body ?? '',
            createdAt: data.received_at,
        };
    }
}
