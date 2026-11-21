/** username 表仓储:已绑定临时邮箱的账号 + 邮箱 session(resume/phase8 复用)。 */
import type { DBType } from './db.js';
import type { MailSession } from '../providers/mail/MailProvider.js';

export interface UsernameRow {
    readonly id: number;
    readonly accountId: number;
    readonly email: string;
    readonly mailProvider: string;
    readonly mailSession: MailSession | null;
    readonly status: string;
    readonly createdAt: string;
}

interface UsernameRowDb {
    id: number;
    account_id: number;
    email: string;
    mail_provider: string;
    mail_session_json: string;
    status: string;
    created_at: string;
}

function toRow(r: UsernameRowDb): UsernameRow {
    let session: MailSession | null = null;
    try {
        session = JSON.parse(r.mail_session_json) as MailSession;
    } catch {
        session = null;
    }
    return {
        id: r.id,
        accountId: r.account_id,
        email: r.email,
        mailProvider: r.mail_provider,
        mailSession: session,
        status: r.status,
        createdAt: r.created_at,
    };
}

export class UsernameRepository {
    constructor(private readonly db: DBType) {}

    insert(input: {
        accountId: number;
        email: string;
        mailProvider: string;
        mailSession: MailSession;
        status?: string;
    }): number {
        const info = this.db
            .prepare(
                `INSERT INTO username (account_id, email, mail_provider, mail_session_json, status) VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
                input.accountId,
                input.email,
                input.mailProvider,
                JSON.stringify(input.mailSession),
                input.status ?? 'email_bound',
            );
        return Number(info.lastInsertRowid);
    }

    findByEmail(email: string): UsernameRow | null {
        const row = this.db.prepare(`SELECT * FROM username WHERE email = ?`).get(email) as unknown as UsernameRowDb | undefined;
        return row ? toRow(row) : null;
    }

    findAll(): UsernameRow[] {
        const rows = this.db.prepare(`SELECT * FROM username ORDER BY id`).all() as unknown as UsernameRowDb[];
        return rows.map(toRow);
    }
}
