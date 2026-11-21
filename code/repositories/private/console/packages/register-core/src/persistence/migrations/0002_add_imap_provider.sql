-- Migration 0002: 将 mail_provider CHECK 约束从 ('legacy','yyds') 扩展为 ('legacy','yyds','imap','cdk')。
-- SQLite 不支持 ALTER TABLE ... MODIFY CONSTRAINT,需重建表。

CREATE TABLE IF NOT EXISTS username_new (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id         INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email              TEXT    NOT NULL UNIQUE,
    mail_provider      TEXT    NOT NULL CHECK (mail_provider IN ('legacy','yyds','imap','cdk')),
    mail_session_json  TEXT    NOT NULL,
    status             TEXT    NOT NULL DEFAULT 'email_bound',
    created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO username_new
    SELECT * FROM username;

DROP TABLE IF EXISTS username;
ALTER TABLE username_new RENAME TO username;

CREATE INDEX IF NOT EXISTS idx_username_account ON username(account_id);
