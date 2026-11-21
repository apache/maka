/** tokens 表仓储:换到的 Codex token(敏感,access/refresh 明文存储,见 README 合规说明)。 */
import type { DBType } from './db.js';

export interface TokenRow {
    readonly id: number;
    readonly usernameId: number;
    readonly email: string;
    readonly accountId: string;
    readonly accessToken: string;
    readonly refreshToken: string | null;
    readonly idToken: string | null;
    readonly expiredAt: string | null;
    readonly savedFilePaths: readonly string[];
    readonly createdAt: string;
}

interface TokenRowDb {
    id: number;
    username_id: number;
    email: string;
    account_id: string | null;
    access_token: string;
    refresh_token: string | null;
    id_token: string | null;
    expired_at: string | null;
    saved_file_paths_json: string | null;
    created_at: string;
}

function toRow(r: TokenRowDb): TokenRow {
    let paths: string[] = [];
    try {
        paths = r.saved_file_paths_json ? (JSON.parse(r.saved_file_paths_json) as string[]) : [];
    } catch {
        paths = [];
    }
    return {
        id: r.id,
        usernameId: r.username_id,
        email: r.email,
        accountId: r.account_id ?? '',
        accessToken: r.access_token,
        refreshToken: r.refresh_token,
        idToken: r.id_token,
        expiredAt: r.expired_at,
        savedFilePaths: paths,
        createdAt: r.created_at,
    };
}

export class TokenRepository {
    constructor(private readonly db: DBType) {}

    insert(input: {
        usernameId: number;
        email: string;
        accountId: string;
        accessToken: string;
        refreshToken: string;
        idToken: string;
        expiredAt: string;
        savedFilePaths: readonly string[];
    }): number {
        const info = this.db
            .prepare(
                `INSERT INTO tokens (username_id, email, account_id, access_token, refresh_token, id_token, expired_at, saved_file_paths_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                input.usernameId,
                input.email,
                input.accountId,
                input.accessToken,
                input.refreshToken,
                input.idToken,
                input.expiredAt,
                JSON.stringify(input.savedFilePaths),
            );
        return Number(info.lastInsertRowid);
    }

    findByEmail(email: string): TokenRow | null {
        const row = this.db.prepare(`SELECT * FROM tokens WHERE email = ? ORDER BY id DESC LIMIT 1`).get(email) as
            | TokenRowDb
            | undefined;
        return row ? toRow(row) : null;
    }
}
