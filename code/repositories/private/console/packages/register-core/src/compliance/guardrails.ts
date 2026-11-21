/**
 * 合规护栏:速率限制(令牌桶)+ 账号间最小延迟。
 * 默认 5 账号/小时、间隔 60s,防止触发风控。
 */
import { RateLimiter } from '../infra/rateLimiter.js';
import { Compliance } from '../config/constants.js';
import type { AppConfig } from '../config/schema.js';

export class Guardrails {
    private readonly limiter: RateLimiter;

    constructor(private readonly cfg: AppConfig) {
        this.limiter = new RateLimiter({
            maxPerWindow: cfg.compliance.maxAccountsPerHour,
            windowMs: Compliance.WINDOW_HOUR_MS,
        });
    }

    /** 每个账号开始前调用:占用配额 + 最小间隔。 */
    async beforeAccount(): Promise<void> {
        await this.limiter.acquire();
        const delay = this.cfg.compliance.minDelayMs;
        if (delay > 0) {
            await new Promise((r) => setTimeout(r, delay));
        }
    }
}
