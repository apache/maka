/**
 * mail-sdk 公共导出(barrel)。
 * 类型 + 工厂 + core 纯函数 + 已实现的适配器。
 */
// 领域类型
export * from './types/mail.js';
export * from './types/provider.js';
export * from './types/credential.js';

// 错误体系
export * from './core/errors.js';

// core 纯函数
export { parseAddressHeader, firstAddress } from './core/address.js';
export { decodeBase64, decodeBase64Url, decodeQuotedPrintable, decodeEncodedWords } from './core/decode.js';
export { normalizeDate } from './core/date.js';
export { extractMimePart } from './core/mime.js';

// 工厂
export { createProvider } from './factory.js';
export type { ProviderConfig } from './factory.js';

// 聚合层
export { MailAggregator } from './aggregator/MailAggregator.js';
export type {
    ProviderSlot,
    TaggedMessage,
    AggregatorListResult,
    AggregatorSearchResult,
} from './aggregator/MailAggregator.js';

// 已实现适配器
export { TempMailProvider } from './providers/tempmail/TempMailProvider.js';
export type { TempMailProviderOptions } from './providers/tempmail/TempMailProvider.js';
export { ImapProvider } from './providers/imap/ImapProvider.js';
export type { ImapProviderOptions } from './providers/imap/ImapProvider.js';
export { GraphProvider } from './providers/graph/GraphProvider.js';
export type { GraphProviderOptions } from './providers/graph/GraphProvider.js';
export { GmailProvider } from './providers/gmail/GmailProvider.js';
export type { GmailProviderOptions } from './providers/gmail/GmailProvider.js';
