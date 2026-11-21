/**
 * Adapters Module
 * 提供编辑器配置文件的路径解析和读取能力（仅保留 execute.ts 消费的扫描面）
 */

export { getConfigFilePath, validatePathAllowed } from './paths'
export { scanSettings } from './scanner'
export type { ScanResult } from './scanner'
