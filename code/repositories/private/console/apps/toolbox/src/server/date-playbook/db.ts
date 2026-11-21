import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

// blog.db 唯一开库点：venues 与 couple 两个仓库共用一个连接（WAL）。
// BLOG_DATA_DIR 供测试隔离。

const dataDir = process.env.BLOG_DATA_DIR ?? path.join(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

export const blogDb = new DatabaseSync(path.join(dataDir, "blog.db"));

// SSG 的多个 build worker 并发求值路由模块时，建表/写入会同时抢 SQLite 写锁；
// busy_timeout 让后到者排队等待而不是立即抛 database is locked。
blogDb.exec("PRAGMA busy_timeout = 5000;");
