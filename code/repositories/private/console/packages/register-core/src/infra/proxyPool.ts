/**
 * 代理池:支持多代理轮换 + 健康检查 + 自动故障踢出。
 * 抗风控核心组件:批量注册时每个账号走不同 IP,避免同一 IP 被 OpenAI 标记为自动化农场。
 *
 * 策略:
 * - round-robin: 依次轮询,最均匀
 * - random: 随机选取,简单粗暴
 * - least-used: 选使用次数最少的,负载均衡
 *
 * 故障处理:
 * - markFailed 记录失败,连续失败 >= maxFailures 自动踢出
 * - markSuccess 重置失败计数(代理恢复)
 * - 所有代理都被踢出时,自动重置(允许最后一搏)
 */
import type { ProxyConfig } from './proxy.js';

export type ProxyStrategy = 'round-robin' | 'random' | 'least-used';

export interface ProxyPoolEntry {
    readonly proxy: ProxyConfig;
    failures: number;
    useCount: number;
    lastUsedAt: number;
    /** 是否被临时踢出。 */
    excluded: boolean;
}

export interface ProxyPoolOptions {
    readonly proxies: ProxyConfig[];
    readonly strategy?: ProxyStrategy;
    /** 连续失败多少次后踢出,默认 2。 */
    readonly maxFailures?: number;
    /** 被踢出的代理多久后自动恢复(ms),默认 300_000(5 分钟)。 */
    readonly cooldownMs?: number;
}

export class ProxyPool {
    private readonly _entries: ProxyPoolEntry[];
    private readonly strategy: ProxyStrategy;
    private readonly maxFailures: number;
    private readonly cooldownMs: number;
    private cursor = 0;

    constructor(opts: ProxyPoolOptions) {
        if (!opts.proxies.length) throw new Error('ProxyPool: 代理列表不能为空');
        this.strategy = opts.strategy ?? 'round-robin';
        this.maxFailures = opts.maxFailures ?? 2;
        this.cooldownMs = opts.cooldownMs ?? 300_000;
        this._entries = opts.proxies.map((p) => ({
            proxy: p,
            failures: 0,
            useCount: 0,
            lastUsedAt: 0,
            excluded: false,
        }));
    }

    /** 返回可用代理数量。 */
    healthy(): number {
        return this._entries.filter((e) => this.isAvailable(e)).length;
    }

    /** 获取总代理数。 */
    get size(): number {
        return this._entries.length;
    }

    /** 获取下一个可用代理。所有代理都不可用时抛错。 */
    acquire(): ProxyConfig {
        this.expireCooldowns();

        const available = this._entries.filter((e) => this.isAvailable(e));
        if (!available.length) {
            // 全部不可用:重置所有排除标记做最后一搏
            for (const e of this._entries) {
                e.excluded = false;
                e.failures = 0;
            }
            throw new Error('ProxyPool: 所有代理均不可用,已重置为全可用状态,请重试');
        }

        let entry: ProxyPoolEntry;
        switch (this.strategy) {
            case 'random':
                entry = available[Math.floor(Math.random() * available.length)]!;
                break;
            case 'least-used':
                entry = available.reduce((a, b) => (a.useCount <= b.useCount ? a : b));
                break;
            case 'round-robin':
            default:
                // round-robin:在可用池中按 cursor 循环
                this.cursor = (this.cursor + 1) % available.length;
                entry = available[this.cursor]!;
                break;
        }

        entry.useCount++;
        entry.lastUsedAt = Date.now();
        return entry.proxy;
    }

    /** 标记代理成功(重置失败计数)。 */
    markSuccess(proxy: ProxyConfig): void {
        const entry = this.find(proxy);
        if (entry) entry.failures = 0;
    }

    /** 标记代理失败:连续失败达到阈值则临时踢出。 */
    markFailed(proxy: ProxyConfig): void {
        const entry = this.find(proxy);
        if (!entry) return;
        entry.failures++;
        if (entry.failures >= this.maxFailures) {
            entry.excluded = true;
            entry.lastUsedAt = Date.now(); // 记录排除时间，用于冷却恢复
        }
    }

    /** 遍历所有代理条目(调试/监控用)。 */
    entries(): readonly ProxyPoolEntry[] {
        return this._entries;
    }

    // ---- 内部 ----

    private find(proxy: ProxyConfig): ProxyPoolEntry | undefined {
        return this._entries.find(
            (e) => e.proxy.host === proxy.host && e.proxy.port === proxy.port,
        );
    }

    private isAvailable(e: ProxyPoolEntry): boolean {
        return !e.excluded;
    }

    /** 冷却恢复:被踢出超过 cooldownMs 的代理自动恢复。 */
    private expireCooldowns(): void {
        const now = Date.now();
        for (const e of this._entries) {
            if (e.excluded && e.lastUsedAt > 0 && now - e.lastUsedAt >= this.cooldownMs) {
                e.excluded = false;
                e.failures = 0;
            }
        }
    }
}

/**
 * 从逗号分隔的字符串解析代理列表。
 * 格式: "host:port:user:pass,host:port:user:pass,..."
 * 或:   "host:port,host:port,..." (无认证)
 */
export function parseProxyList(raw: string): ProxyConfig[] {
    if (!raw?.trim()) return [];
    return raw
        .split(',')
        .map((seg) => seg.trim())
        .filter(Boolean)
        .map((seg) => {
            const parts = seg.split(':');
            const host = parts[0];
            const port = parseInt(parts[1] ?? '', 10);
            if (!host || isNaN(port)) return null;
            const cfg: ProxyConfig = { host, port, source: 'config' };
            if (parts[2]) cfg.username = parts[2];
            if (parts[3]) cfg.password = parts[3];
            return cfg;
        })
        .filter((c): c is ProxyConfig => c !== null);
}
