import { describe, it, expect } from 'vitest';
import { parseProxyEndpoint, detectProxyFromEnv } from '../../src/infra/proxy.js';

describe('parseProxyEndpoint', () => {
    it('解析 host:port', () => {
        expect(parseProxyEndpoint('1.2.3.4:8080')).toEqual({ host: '1.2.3.4', port: 8080 });
    });
    it('解析 scheme://host:port', () => {
        expect(parseProxyEndpoint('http://proxy.example.com:3128')).toEqual({ host: 'proxy.example.com', port: 3128 });
    });
    it('解析带账密', () => {
        const r = parseProxyEndpoint('http://user:pass@host:80');
        expect(r).toEqual({ host: 'host', port: 80, username: 'user', password: 'pass' });
    });
    it('https 无端口默认 443', () => {
        expect(parseProxyEndpoint('https://h.com')?.port).toBe(443);
    });
    it('空/非法返回 null', () => {
        expect(parseProxyEndpoint('')).toBeNull();
        expect(parseProxyEndpoint(':::::')).toBeNull();
    });
});

describe('detectProxyFromEnv', () => {
    it('从 HTTPS_PROXY 探测并标记 source', () => {
        const r = detectProxyFromEnv({ HTTPS_PROXY: 'http://envproxy:1080' });
        expect(r?.host).toBe('envproxy');
        expect(r?.source).toBe('env');
    });
    it('无相关变量返回 null', () => {
        expect(detectProxyFromEnv({})).toBeNull();
    });
});
