/**
 * SQLite 数据库连接 + 迁移。
 * 使用 node:sqlite(Node 24 内置,同步),开启 WAL(并发读不阻塞写)+ foreign_keys。
 * 迁移通过读取 migrations/*.sql 执行(幂等 CREATE IF NOT EXISTS)。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** node:sqlite 的 DatabaseSync 实例类型(重命名,避免与构造函数混淆)。 */
export type DBType = InstanceType<typeof DatabaseSync>;

export function openDatabase(dbPath: string): DBType {
    const resolved = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const db = new DatabaseSync(resolved);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    runMigrations(db);
    return db;
}

function runMigrations(db: DBType): void {
    const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
    if (!fs.existsSync(migrationsDir)) return;
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        db.exec(sql);
    }
}
