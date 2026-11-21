/**
 * accounts 表仓储。示范:用 prepared statements + 事务保证原子性,
 * 替代 demo 里 readFileSync→改→writeFileSync 的非原子读写。
 */
import type { DBType } from './db.js';

export type AccountStatus =
    | 'registered'
    | 'email_bound'
    | 'oauth_done'
    | 'password_incorrect'
    | 'registration_failed';

export interface AccountRow {
    readonly id: number;
    readonly phone: string;
    readonly password: string;
    readonly fullName: string;
    readonly birthDate: string;
    readonly status: AccountStatus;
    readonly createdAt: string;
    readonly updatedAt: string;
}

interface AccountRowDb {
    id: number;
    phone: string;
    password: string;
    full_name: string;
    birth_date: string;
    status: string;
    created_at: string;
    updated_at: string;
}

function toRow(r: AccountRowDb): AccountRow {
    return {
        id: r.id,
        phone: r.phone,
        password: r.password,
        fullName: r.full_name,
        birthDate: r.birth_date,
        status: r.status as AccountStatus,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

export class AccountRepository {
    constructor(private readonly db: DBType) {}

    insert(input: { phone: string; password: string; fullName: string; birthDate: string }): number {
        const info = this.db
            .prepare(`INSERT INTO accounts (phone, password, full_name, birth_date, status) VALUES (?, ?, ?, ?, 'registered')`)
            .run(input.phone, input.password, input.fullName, input.birthDate);
        return Number(info.lastInsertRowid);
    }

    findByPhone(phone: string): AccountRow | null {
        const row = this.db.prepare(`SELECT * FROM accounts WHERE phone = ?`).get(phone) as unknown as AccountRowDb | undefined;
        return row ? toRow(row) : null;
    }

    /** 取一个 status=registered 且有密码的账号(resume 模式用)。 */
    findRegistered(): AccountRow | null {
        const row = this.db
            .prepare(`SELECT * FROM accounts WHERE status = 'registered' AND password != '' LIMIT 1`)
            .get() as unknown as AccountRowDb | undefined;
        return row ? toRow(row) : null;
    }

    updateStatus(phone: string, status: AccountStatus): void {
        this.db
            .prepare(`UPDATE accounts SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE phone = ?`)
            .run(status, phone);
    }

    /**
     * 原子地标记 OAuth 完成(事务内可联动多表操作)。
     * 调用方应把此方法与 TokenRepository.insert 放在同一事务中,
     * 本方法通过 tx 参数接收外部事务(或内部自启事务兜底)。
     */
    markOauthDone(phone: string): void {
        this.db
            .prepare(`UPDATE accounts SET status = 'oauth_done', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE phone = ?`)
            .run(phone);
    }

    countByStatus(status: AccountStatus): number {
        const row = this.db.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE status = ?`).get(status) as { n: number };
        return row.n;
    }
}
