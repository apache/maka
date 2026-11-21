/**
 * OAuth 客户端:授权 URL 构造 + 回调参数解析 + code 换 token + 文件落盘。
 * 迁移自现有 oauthService.js,改造:TS 类型、PKCE 独立为纯函数、HTTP/代理可注入、token 多目录双写。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AxiosInstance } from 'axios';
import type { AppConfig } from '../config/schema.js';
import { OAuth } from '../config/constants.js';
import { generatePkce, type PkceParams } from './PkceService.js';
import { readAccountIdFromToken } from './jwtReader.js';
import { createHttpClient } from '../infra/http.js';
import type { ProxyConfig } from '../infra/proxy.js';

export interface CallbackParams {
    readonly code: string | null;
    readonly state: string | null;
    readonly error: string | null;
    readonly errorDescription: string | null;
}

export interface SavedToken {
    readonly access_token: string;
    readonly account_id: string;
    readonly disabled: boolean;
    readonly email: string;
    readonly expired: string;
    readonly id_token: string;
    readonly last_refresh: string;
    readonly refresh_token: string;
    readonly type: 'codex';
}

export interface TokenExchangeResult {
    readonly token: SavedToken;
    readonly savedPaths: readonly string[];
}

export class OAuthClient {
    readonly redirectUri: string;
    private pkce: PkceParams;
    private readonly http: AxiosInstance;

    constructor(private readonly cfg: AppConfig, proxy?: ProxyConfig | null) {
        this.redirectUri = `http://localhost:${cfg.oauth.redirectPort}${OAuth.REDIRECT_PATH}`;
        this.pkce = generatePkce();
        this.http = createHttpClient({ timeoutMs: 30_000, proxy: proxy ?? undefined });
    }

    regeneratePkce(): void {
        this.pkce = generatePkce();
    }

    /** 构造 Codex OAuth 授权 URL(PKCE + simplified flow)。 */
    getAuthUrl(): string {
        const params = new URLSearchParams({
            client_id: this.cfg.oauth.clientId,
            code_challenge: this.pkce.codeChallenge,
            code_challenge_method: 'S256',
            codex_cli_simplified_flow: 'true',
            id_token_add_organizations: 'true',
            redirect_uri: this.redirectUri,
            response_type: 'code',
            scope: OAuth.SCOPE,
            state: this.pkce.state,
        });
        return `${OAuth.AUTH_BASE}/oauth/authorize?${params.toString()}`;
    }

    /** 从 localhost 回调 URL 提取参数;state 不匹配返回 null。 */
    extractCallbackParams(callbackUrl: string): CallbackParams | null {
        try {
            const u = new URL(callbackUrl);
            const params: CallbackParams = {
                code: u.searchParams.get('code'),
                state: u.searchParams.get('state'),
                error: u.searchParams.get('error'),
                errorDescription: u.searchParams.get('error_description'),
            };
            if (params.state && params.state !== this.pkce.state) return null;
            return params;
        } catch {
            return null;
        }
    }

    /**
     * 用授权码换 token。只做 HTTP 交换 + 数据构造,不做文件落盘。
     * 文件写入由调用方在数据库事务成功后执行,避免孤儿 token 文件。
     */
    async exchangeTokenAndSave(code: string, email: string): Promise<TokenExchangeResult> {
        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: this.redirectUri,
            client_id: this.cfg.oauth.clientId,
            code_verifier: this.pkce.codeVerifier,
        }).toString();

        const resp = await this.http.post(`${OAuth.AUTH_BASE}/oauth/token`, body, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 30_000,
        });
        const tokens = resp.data as {
            access_token: string;
            refresh_token: string;
            id_token: string;
            expires_in: number;
        };

        const accountId = readAccountIdFromToken(tokens.access_token);
        const now = new Date();
        const expired = new Date(now.getTime() + tokens.expires_in * 1000);
        const token: SavedToken = {
            access_token: tokens.access_token,
            account_id: accountId,
            disabled: false,
            email,
            expired: expired.toISOString(),
            id_token: tokens.id_token,
            last_refresh: now.toISOString(),
            refresh_token: tokens.refresh_token,
            type: 'codex',
        };

        return { token, savedPaths: [] };
    }

    /**
     * 将 token 写入文件系统(应在数据库事务成功后调用)。
     * 与 exchangeTokenAndSave 分离:交易归交易,落盘归落盘。
     */
    saveTokenFiles(token: SavedToken, email: string): string[] {
        const dirs = this.cfg.oauth.tokenOutputDirs.length > 0 ? [...new Set(this.cfg.oauth.tokenOutputDirs)] : ['tokens'];
        const safeEmail = email.replace(/[\\/:*?"<>|]/g, '_');
        const filename = `codex-${safeEmail}-free.json`;
        const paths: string[] = [];
        for (const dir of dirs) {
            fs.mkdirSync(dir, { recursive: true });
            const fp = path.join(dir, filename);
            fs.writeFileSync(fp, JSON.stringify(token, null, 2), { mode: 0o600 });
            paths.push(fp);
        }
        return paths;
    }
}
