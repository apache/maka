-- 初始 schema:accounts / username / tokens / runs 四张表。
-- 所有"读-改-写"操作改为事务,修复 demo 用 writeFileSync 非原子的问题。

CREATE TABLE IF NOT EXISTS accounts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    phone       TEXT    NOT NULL UNIQUE,
    password    TEXT    NOT NULL,
    full_name   TEXT    NOT NULL,
    birth_date  TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'registered'
                CHECK (status IN ('registered','email_bound','oauth_done',
                                  'password_incorrect','registration_failed')),
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);

CREATE TABLE IF NOT EXISTS username (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id         INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email              TEXT    NOT NULL UNIQUE,
    mail_provider      TEXT    NOT NULL CHECK (mail_provider IN ('legacy','yyds')),
    mail_session_json  TEXT    NOT NULL,
    status             TEXT    NOT NULL DEFAULT 'email_bound',
    created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_username_account ON username(account_id);

CREATE TABLE IF NOT EXISTS tokens (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    username_id           INTEGER NOT NULL REFERENCES username(id) ON DELETE CASCADE,
    email                 TEXT    NOT NULL,
    account_id            TEXT,
    access_token          TEXT    NOT NULL,
    refresh_token         TEXT,
    id_token              TEXT,
    expired_at            TEXT,
    saved_file_paths_json TEXT,
    created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_tokens_username ON tokens(username_id);
CREATE INDEX IF NOT EXISTS idx_tokens_email ON tokens(email);

CREATE TABLE IF NOT EXISTS runs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id           TEXT    NOT NULL UNIQUE,
    account_phone    TEXT,
    mode             TEXT    NOT NULL CHECK (mode IN ('register','resume','phase8')),
    started_at       TEXT    NOT NULL,
    finished_at      TEXT,
    status           TEXT    NOT NULL CHECK (status IN ('running','success','failed','cancelled')),
    error_message    TEXT,
    phases_reached   TEXT,
    report_json      TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
