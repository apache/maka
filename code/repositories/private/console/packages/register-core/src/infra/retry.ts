/**
 * 通用重试工具:指数退避 + 抖动 + 可配置的 retryOn 判定。
 * 替代 demo 里到处硬编码的固定间隔轮询。
 */

export interface RetryOptions {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs?: number;
    jitter?: boolean;
    /** 返回 true 才重试;返回 false 立即抛出。 */
    retryOn?: (error: unknown, attempt: number) => boolean;
    /** 每次重试前的回调(日志/埋点)。 */
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/** 判断一个 HTTP 错误是否值得重试(网络错误 / 429 / 5xx)。 */
export function isRetryableHttpError(error: unknown): boolean {
    const code = (error as { code?: string } | null)?.code;
    const status = (error as { response?: { status?: number } } | null)?.response?.status;
    if (code && ['EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ERR_PROXY_CONNECTION_FAILED'].includes(code)) {
        return true;
    }
    if (status === 429 || (typeof status === 'number' && status >= 500 && status <= 599)) {
        return true;
    }
    return false;
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
    const { maxAttempts, baseDelayMs } = opts;
    const maxDelayMs = opts.maxDelayMs ?? 30_000;
    const jitter = opts.jitter ?? true;
    const retryOn = opts.retryOn ?? (() => true);
    const onRetry = opts.onRetry;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn(attempt);
        } catch (e) {
            lastError = e;
            if (attempt >= maxAttempts || !retryOn(e, attempt)) {
                break;
            }
            const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
            const delay = jitter ? Math.round(exponential * (0.5 + Math.random() * 0.5)) : exponential;
            onRetry?.(e, attempt, delay);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
    throw lastError;
}
