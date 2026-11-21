/**
 * 邮箱提供商工厂:按 config.mail.provider 选择实现。
 * legacy / imap / cdk 已实现;yyds 留接口 + TODO。
 */
import type { AppConfig } from '../../config/schema.js';
import type { MailProvider } from './MailProvider.js';
import { LegacyMailProvider } from './LegacyMailProvider.js';
import { ImapMailProvider } from './ImapMailProvider.js';
import { CdkMailProvider } from './CdkMailProvider.js';

export function createMailProvider(cfg: AppConfig): MailProvider {
    switch (cfg.mail.provider) {
        case 'legacy':
            return new LegacyMailProvider({
                baseUrl: cfg.mail.legacy.baseUrl,
                adminPassword: cfg.mail.legacy.adminPassword,
                sitePassword: cfg.mail.legacy.sitePassword,
                domain: cfg.mail.legacy.domain,
            });
        case 'yyds':
            // TODO: YydsMailProvider 实现(接口已就绪,迁移 yydsMailProvider.js + 自动拉域名 + getMails hydrate)。
            throw new Error('createMailProvider: yyds 渠道尚未实现(留作接口增量示范)');
        case 'imap':
            return new ImapMailProvider({
                user: cfg.mail.imap.user,
                password: cfg.mail.imap.password,
                host: cfg.mail.imap.host || undefined,
                port: cfg.mail.imap.port,
                tls: cfg.mail.imap.tls,
            });
        case 'cdk':
            return new CdkMailProvider({
                cdkKey: cfg.mail.cdk.cdkKey,
                email: cfg.mail.cdk.email,
                apiBaseUrl: cfg.mail.cdk.apiBaseUrl || undefined,
            });
        default: {
            const exhaustive: never = cfg.mail.provider;
            throw new Error(`createMailProvider: 未知 provider ${String(exhaustive)}`);
        }
    }
}
