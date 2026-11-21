/**
 * HTTP 客户端工厂:统一 timeout / proxy / headers,供 provider 复用。
 */
import axios, { type AxiosInstance, type AxiosProxyConfig } from 'axios';
import type { ProxyConfig } from './proxy.js';

export interface HttpClientOptions {
    baseURL?: string;
    timeoutMs?: number;
    proxy?: ProxyConfig;
    headers?: Record<string, string>;
}

function toAxiosProxy(p: ProxyConfig): AxiosProxyConfig {
    const cfg: AxiosProxyConfig = { host: p.host, port: p.port };
    if (p.username || p.password) {
        cfg.auth = { username: p.username ?? '', password: p.password ?? '' };
    }
    return cfg;
}

export function createHttpClient(opts: HttpClientOptions = {}): AxiosInstance {
    return axios.create({
        baseURL: opts.baseURL,
        timeout: opts.timeoutMs ?? 30_000,
        headers: opts.headers,
        ...(opts.proxy ? { proxy: toAxiosProxy(opts.proxy) } : {}),
    });
}
