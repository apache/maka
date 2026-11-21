/**
 * 编辑器配置文件路径解析
 * 支持 macOS / Windows / Linux
 */

import * as path from 'node:path'
import * as os from 'node:os'

import type { TargetType, ConfigFileType } from '@ggbdpq/console-shared'

// ============================================================================
// Types
// ============================================================================

export interface ConfigPaths {
  /** settings.json 路径 */
  settings: string
  /** keybindings.json 路径 */
  keybindings: string
  /** snippets 目录路径 */
  snippetsDir: string
  /** 配置根目录 */
  configDir: string
}

export type Platform = 'darwin' | 'win32' | 'linux'

// ============================================================================
// Platform Detection
// ============================================================================

/**
 * 获取当前平台
 */
export function getPlatform(): Platform {
  const platform = os.platform()
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') {
    return platform
  }
  // 默认使用 linux 路径规则
  return 'linux'
}

// ============================================================================
// VSCode Path Resolution
// ============================================================================

/**
 * 获取 VSCode 用户配置目录
 */
function getVSCodeConfigDir(platform: Platform = getPlatform()): string {
  const home = os.homedir()

  switch (platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Code', 'User')
    case 'win32':
      // Windows: %APPDATA%\Code\User
      const appData = process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming')
      return path.join(appData, 'Code', 'User')
    case 'linux':
      // Linux: ~/.config/Code/User
      const configHome = process.env['XDG_CONFIG_HOME'] ?? path.join(home, '.config')
      return path.join(configHome, 'Code', 'User')
    default:
      throw new Error(`Unsupported platform: ${platform}`)
  }
}

// ============================================================================
// Cursor Path Resolution
// ============================================================================

/**
 * 获取 Cursor 用户配置目录
 */
function getCursorConfigDir(platform: Platform = getPlatform()): string {
  const home = os.homedir()

  switch (platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Cursor', 'User')
    case 'win32':
      // Windows: %APPDATA%\Cursor\User
      const appData = process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming')
      return path.join(appData, 'Cursor', 'User')
    case 'linux':
      // Linux: ~/.config/Cursor/User
      const configHome = process.env['XDG_CONFIG_HOME'] ?? path.join(home, '.config')
      return path.join(configHome, 'Cursor', 'User')
    default:
      throw new Error(`Unsupported platform: ${platform}`)
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * 根据目标类型获取配置目录
 */
export function getConfigDir(targetType: TargetType, platform?: Platform): string {
  const p = platform ?? getPlatform()

  switch (targetType) {
    case 'vscode':
      return getVSCodeConfigDir(p)
    case 'cursor':
      return getCursorConfigDir(p)
    default:
      throw new Error(`Unsupported target type: ${targetType as string}`)
  }
}

/**
 * 获取完整的配置文件路径集合
 */
export function getConfigPaths(targetType: TargetType, platform?: Platform): ConfigPaths {
  const configDir = getConfigDir(targetType, platform)
  return {
    settings: path.join(configDir, 'settings.json'),
    keybindings: path.join(configDir, 'keybindings.json'),
    snippetsDir: path.join(configDir, 'snippets'),
    configDir,
  }
}

/**
 * 获取特定配置文件的路径
 */
export function getConfigFilePath(
  targetType: TargetType,
  fileType: ConfigFileType,
  platform?: Platform
): string {
  const paths = getConfigPaths(targetType, platform)
  switch (fileType) {
    case 'settings':
      return paths.settings
    case 'keybindings':
      return paths.keybindings
    case 'snippets':
      return paths.snippetsDir
    default:
      throw new Error(`Unsupported file type: ${fileType as string}`)
  }
}

// ============================================================================
// Allowlist Validation
// ============================================================================

/**
 * 允许写入的目录白名单
 * 只允许写入 VSCode 和 Cursor 的用户配置目录
 */
function getAllowedDirs(platform?: Platform): string[] {
  const p = platform ?? getPlatform()
  return [getVSCodeConfigDir(p), getCursorConfigDir(p)]
}

/**
 * 验证路径是否在白名单目录内
 * @throws 如果路径不在白名单内
 */
export function validatePathAllowed(filePath: string, platform?: Platform): void {
  const normalizedPath = path.normalize(filePath)
  const allowedDirs = getAllowedDirs(platform)

  const isAllowed = allowedDirs.some((dir) => {
    const normalizedDir = path.normalize(dir)
    return normalizedPath.startsWith(normalizedDir + path.sep) || normalizedPath === normalizedDir
  })

  if (!isAllowed) {
    throw new Error(
      `Path not allowed: ${filePath}. Only VSCode and Cursor config directories are permitted.`
    )
  }
}

/**
 * 检查路径是否在白名单目录内（不抛异常）
 */
export function isPathAllowed(filePath: string, platform?: Platform): boolean {
  try {
    validatePathAllowed(filePath, platform)
    return true
  } catch {
    return false
  }
}
