import { describe, it, expect, vi } from 'vitest';
import type { AxiosInstance } from 'axios';
import { CdkMailProvider } from '../../src/providers/mail/CdkMailProvider.js';
import { asEmail } from '../../src/types/brand.js';

/** 构建一个 mock HTTP 客户端,返回指定的 CDK API 响应。 */
function mockHttp(response: Record<string, unknown>): AxiosInstance {
    return {
        get: vi.fn(async () => ({ data: response })),
    } as unknown as AxiosInstance;
}

describe('CdkMailProvider', () => {
    it('构造时缺少 cdkKey 或 email 抛错', () => {
        expect(() => new CdkMailProvider({ cdkKey: '', email: '' })).toThrow('cdkKey / email 必填');
        expect(() => new CdkMailProvider({ cdkKey: 'k', email: '' })).toThrow('cdkKey / email 必填');
    });

    it('createAddress 返回预配置邮箱,无网络调用', async () => {
        const p = new CdkMailProvider({ cdkKey: 'Mail-test', email: 'a@outlook.com' });
        const created = await p.createAddress();
        expect(created.address).toBe('a@outlook.com');
        expect(created.session.provider).toBe('cdk');
        expect(created.session.cdkKey).toBe('Mail-test');
    });

    it('getMails 调 API 并适配字段', async () => {
        const http = mockHttp({
            status: 'success',
            subject: 'Verification Code',
            from: 'noreply@openai.com',
            body: 'Your code is 123456',
            received_at: '2026-06-25T08:00:00Z',
        });
        const p = new CdkMailProvider({ cdkKey: 'Mail-test', email: 'a@outlook.com', httpClient: http });
        await p.createAddress();

        const mails = await p.getMails(5);
        expect(mails).toHaveLength(1);
        expect(mails[0]?.subject).toContain('Verification');
        expect(mails[0]?.text).toContain('123456');
        expect(mails[0]?.createdAt).toBe('2026-06-25T08:00:00Z');
    });

    it('API 返回 error 状态时返回空数组', async () => {
        const http = mockHttp({ status: 'error' });
        const p = new CdkMailProvider({ cdkKey: 'Mail-test', email: 'a@outlook.com', httpClient: http });
        await p.createAddress();

        const mails = await p.getMails();
        expect(mails).toHaveLength(0);
    });

    it('getInboxUrl 返回 null', () => {
        const p = new CdkMailProvider({ cdkKey: 'k', email: 'a@outlook.com' });
        expect(p.getInboxUrl()).toBeNull();
    });

    it('getEmail 在 createAddress 后返回配置邮箱', async () => {
        const p = new CdkMailProvider({ cdkKey: 'k', email: 'a@outlook.com' });
        expect(p.getEmail()).toBeNull();
        await p.createAddress();
        expect(p.getEmail()).toBe('a@outlook.com');
    });

    it('useExistingAddressSession 从持久化 session 恢复', () => {
        const p = new CdkMailProvider({ cdkKey: 'orig', email: 'orig@x.com' });
        p.useExistingAddressSession({
            provider: 'cdk',
            address: 'restored@outlook.com' as ReturnType<typeof asEmail>,
            cdkKey: 'Mail-restored',
        });
        expect(p.getEmail()).toBe('restored@outlook.com');
    });

    it('exportSession 返回完整 CDK 会话', async () => {
        const p = new CdkMailProvider({ cdkKey: 'Mail-test', email: 'a@outlook.com' });
        await p.createAddress();
        const session = p.exportSession();
        expect(session?.provider).toBe('cdk');
        expect(session?.address).toBe('a@outlook.com');
        expect(session?.cdkKey).toBe('Mail-test');
    });
});
