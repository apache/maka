/**
 * 代理配置解析:统一处理 scheme://host:port / host:port / 带账密 等多种形态。
 * 迁移自现有 oauthService.js 的 parseProxyEndpoint / detectProxyFromEnv,但抽为纯函数便于单测。
 */

export interface ProxyConfig {
    host: string;
    port: number;
    username?: string;
    password?: string;
    source?: 'env' | 'config';
}

/** 解析单段代理字符串,无法解析返回 null(不抛错,交由调用方决策)。 */
export function parseProxyEndpoint(raw: string): ProxyConfig | null {
    if (!raw || typeof raw !== 'string') return null;
    const text = raw.trim();
    if (!text) return null;
    try {
        const withScheme = text.includes('://') ? text : `http://${text}`;
        const u = new URL(withScheme);
        if (!['http:', 'https:'].includes(u.protocol)) return null;
        const port = parseInt(u.port, 10) || (u.protocol === 'https:' ? 443 : 80);
        if (!u.hostname || !port) return null;
        const cfg: ProxyConfig = {
            host: u.hostname,
            port,
            username: decodeURIComponent(u.username || ''),
            password: decodeURIComponent(u.password || ''),
        };
        // 空串用户名视为未设置(避免 exactOptional 摩擦)
        if (!cfg.username) delete cfg.username;
        if (!cfg.password) delete cfg.password;
        return cfg;
    } catch {
        return null;
    }
}

/** 从环境变量探测代理(HTTPS_PROXY > HTTP_PROXY > ALL_PROXY,大小写不敏感)。 */
export function detectProxyFromEnv(env: NodeJS.ProcessEnv = process.env): ProxyConfig | null {
    const raw =
        env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
    if (!raw) return null;
    const parsed = parseProxyEndpoint(raw);
    return parsed ? { ...parsed, source: 'env' } : null;
}
