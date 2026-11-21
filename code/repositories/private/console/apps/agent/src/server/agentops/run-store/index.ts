/**
 * Run Store Module
 * 提供 Run 记录的持久化存储能力
 *
 * 两种实现：
 * - JsonRunStore: 基于 JSON 文件，适合小规模使用
 * - SqliteRunStore: 基于 SQLite，适合大规模使用
 */

// JSON Store (default)
export { JsonRunStore, createJsonRunStore } from './json-run-store'
export type { JsonRunStoreConfig } from './json-run-store'

// SQLite Store
export { SqliteRunStore, createSqliteRunStore } from './sqlite-run-store'
export type { SqliteRunStoreConfig } from './sqlite-run-store'
