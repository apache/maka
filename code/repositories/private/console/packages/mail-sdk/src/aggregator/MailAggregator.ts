/**
 * MailAggregator:跨多 provider 聚合层。
 * 并行调用所有已注册 provider(Promise.allSettled),单 provider 失败进 errors 不阻塞其他;
 * 合并结果按 date 倒序在内存排序(各 provider 服务端排序无法跨源)。
 * 各源分页 token 独立(IMAP uid range / Graph+Gmail token 机制不同),用 nextTokensByTag 返回。
 */
import type { Folder, MailMessage } from '../types/mail.js';
import type { ListOptions, ListResult, MailProvider, SearchQuery } from '../types/provider.js';

export interface ProviderSlot {
    readonly tag: string;
    readonly provider: MailProvider;
}

export interface TaggedMessage {
    readonly tag: string;
    readonly message: MailMessage;
}

export interface AggregatorListResult {
    readonly messages: readonly TaggedMessage[];
    readonly nextTokensByTag: Readonly<Record<string, string | undefined>>;
    readonly errors: Readonly<Record<string, string>>;
}

export interface AggregatorSearchResult {
    readonly messages: readonly TaggedMessage[];
    readonly errors: Readonly<Record<string, string>>;
}

function reasonToMessage(reason: unknown): string {
    return (reason as Error)?.message ?? String(reason);
}

export class MailAggregator {
    private readonly slots = new Map<string, MailProvider>();

    register(slot: ProviderSlot): this {
        if (this.slots.has(slot.tag)) throw new Error(`MailAggregator: tag "${slot.tag}" 已注册`);
        this.slots.set(slot.tag, slot.provider);
        return this;
    }

    unregister(tag: string): this {
        this.slots.delete(tag);
        return this;
    }

    tags(): readonly string[] {
        return [...this.slots.keys()];
    }

    async listAllFolders(): Promise<readonly (Folder & { readonly tag: string })[]> {
        const entries = [...this.slots.entries()];
        const results = await Promise.allSettled(
            entries.map(async ([, provider]) => provider.listFolders()),
        );
        const out: (Folder & { tag: string })[] = [];
        entries.forEach(([tag], i) => {
            const r = results[i]!;
            if (r.status === 'fulfilled') {
                for (const f of r.value) out.push({ ...f, tag });
            }
        });
        return out;
    }

    async listAcross(options?: ListOptions): Promise<AggregatorListResult> {
        const entries = [...this.slots.entries()];
        const results = await Promise.allSettled(entries.map(([, provider]) => provider.listMessages(options)));

        const messages: TaggedMessage[] = [];
        const nextTokensByTag: Record<string, string | undefined> = {};
        const errors: Record<string, string> = {};

        entries.forEach(([tag], i) => {
            const r = results[i]!;
            if (r.status === 'fulfilled') {
                const list: ListResult = r.value;
                for (const m of list.messages) messages.push({ tag, message: m });
                nextTokensByTag[tag] = list.nextPageToken;
            } else {
                errors[tag] = reasonToMessage(r.reason);
            }
        });

        messages.sort((a, b) => b.message.date.localeCompare(a.message.date));
        return { messages, nextTokensByTag, errors };
    }

    async searchAcross(query: SearchQuery): Promise<AggregatorSearchResult> {
        const entries = [...this.slots.entries()];
        const results = await Promise.allSettled(entries.map(([, provider]) => provider.search(query)));

        const messages: TaggedMessage[] = [];
        const errors: Record<string, string> = {};

        entries.forEach(([tag], i) => {
            const r = results[i]!;
            if (r.status === 'fulfilled') {
                for (const m of r.value.messages) messages.push({ tag, message: m });
            } else {
                errors[tag] = reasonToMessage(r.reason);
            }
        });

        messages.sort((a, b) => b.message.date.localeCompare(a.message.date));
        return { messages, errors };
    }

    async disconnectAll(): Promise<void> {
        await Promise.allSettled([...this.slots.values()].map((p) => p.disconnect()));
        this.slots.clear();
    }
}
