/**
 * Provider 工厂:按 provider 类型 + credential 构造适配器。
 * zod 校验凭据结构 → exhaustive switch 分发(新增 provider 编译期强制补分支)。
 * 每个适配器 connect() 内再校验凭据类型匹配,双层校验。
 */
import type { MailProvider, ProviderName } from './types/provider.js';
import type { Credential } from './types/credential.js';
import { CredentialSchema } from './types/credential.js';
import { TempMailProvider, type TempMailProviderOptions } from './providers/tempmail/TempMailProvider.js';
import { ImapProvider, type ImapProviderOptions } from './providers/imap/ImapProvider.js';
import { GraphProvider, type GraphProviderOptions } from './providers/graph/GraphProvider.js';
import { GmailProvider, type GmailProviderOptions } from './providers/gmail/GmailProvider.js';

export interface ProviderConfig {
    readonly provider: ProviderName;
    readonly credential: Credential;
    readonly options?: Record<string, unknown>;
}

export function createProvider(config: ProviderConfig): MailProvider {
    // 凭据结构校验(不合法抛 ZodError)
    CredentialSchema.parse(config.credential);

    switch (config.provider) {
        case 'imap':
            return new ImapProvider((config.options ?? {}) as ImapProviderOptions);
        case 'tempmail':
            return new TempMailProvider((config.options ?? {}) as TempMailProviderOptions);
        case 'graph':
            return new GraphProvider((config.options ?? {}) as GraphProviderOptions);
        case 'gmail':
            return new GmailProvider((config.options ?? {}) as GmailProviderOptions);
        default: {
            const exhaustive: never = config.provider;
            throw new Error(`createProvider: 未知 provider ${String(exhaustive)}`);
        }
    }
}
