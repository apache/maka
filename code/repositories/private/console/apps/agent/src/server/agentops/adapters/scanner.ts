/**
 * 配置文件扫描器
 * 读取 VSCode/Cursor 的 settings.json
 * 支持 JSONC（带注释和尾逗号的 JSON）
 */

import * as fs from 'node:fs/promises'
import { parse as parseJsonc } from 'jsonc-parser'

import type { TargetType } from '@ggbdpq/console-shared'

import { getConfigFilePath, validatePathAllowed } from './paths'

// ============================================================================
// Types
// ============================================================================

export interface ScanResult {
  /** 目标类型 */
  targetType: TargetType
  /** 配置文件路径 */
  path: string
  /** 配置内容（解析后的 JSON 对象） */
  content: Record<string, unknown>
  /** 文件是否存在 */
  exists: boolean
}

// ============================================================================
// Scanner Implementation
// ============================================================================

/**
 * 读取 settings.json 文件
 * 支持 JSONC 格式（带注释和尾逗号）
 * 如果文件不存在，返回空对象 {}
 */
export async function readSettingsJson(
  targetType: TargetType
): Promise<ScanResult> {
  const filePath = getConfigFilePath(targetType, 'settings')

  // 验证路径在白名单内
  validatePathAllowed(filePath)

  try {
    const content = await fs.readFile(filePath, 'utf-8')
    // 使用 jsonc-parser 解析（支持注释和尾逗号）
    const parsed = parseJsonc(content) as Record<string, unknown>

    return {
      targetType,
      path: filePath,
      content: parsed ?? {},
      exists: true,
    }
  } catch (error) {
    // 如果是文件不存在错误，返回空对象
    if (isNotFoundError(error)) {
      return {
        targetType,
        path: filePath,
        content: {},
        exists: false,
      }
    }
    // 其他错误（如解析错误）抛出
    throw error
  }
}

/**
 * 扫描多个目标的 settings.json
 */
export async function scanSettings(
  targetTypes: TargetType[]
): Promise<ScanResult[]> {
  return Promise.all(targetTypes.map(readSettingsJson))
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * 检查是否为文件不存在错误
 */
function isNotFoundError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}
