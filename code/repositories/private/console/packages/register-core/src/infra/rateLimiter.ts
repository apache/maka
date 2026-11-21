/**
 * 滑动窗口速率限制器(合规护栏用):限制单位时间内的账号注册数量。
 * acquire() 在超额时自动 sleep 到下个窗口,串行调用安全。
 */

export interface RateLimiterOptions {
    /** 窗口内最大允许次数。 */
    maxPerWindow: number;
    /** 窗口长度(毫秒)。 */
    windowMs: number;
}

export class RateLimiter {
    private timestamps: number[] = [];

    constructor(private readonly opts: RateLimiterOptions) {
        if (opts.maxPerWindow <= 0 || opts.windowMs <= 0) {
            throw new Error('RateLimiter: maxPerWindow 与 windowMs 必须为正数');
        }
    }

    /** 占用一个名额;超额则阻塞到最早一个名额释放。 */
    async acquire(): Promise<void> {
        for (;;) {
            const now = Date.now();
            this.timestamps = this.timestamps.filter((t) => now - t < this.opts.windowMs);
            if (this.timestamps.length < this.opts.maxPerWindow) {
                this.timestamps.push(now);
                return;
            }
            const oldest = this.timestamps[0]!;
            const waitMs = this.opts.windowMs - (now - oldest) + 1;
            await new Promise((resolve) => setTimeout(resolve, Math.max(0, waitMs)));
        }
    }

    /** 查询在给定时刻是否会超额(不消费名额),测试用。 */
    wouldBlock(now: number = Date.now()): boolean {
        const valid = this.timestamps.filter((t) => now - t < this.opts.windowMs);
        return valid.length >= this.opts.maxPerWindow;
    }
}
