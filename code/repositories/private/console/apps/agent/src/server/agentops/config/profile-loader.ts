/**
 * Profile Loader
 * 从 YAML 配置文件加载 Profile 配置
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { parse as parseYaml } from 'yaml'

import type { ProfileConfig } from '@ggbdpq/console-shared'

// ============================================================================
// Types
// ============================================================================

/**
 * 配置文件结构
 */
interface ConfigSchema {
  profiles: ProfileConfig[]
}

/**
 * Profile Store 配置
 */
export interface ProfileLoaderConfig {
  /** 配置目录路径 */
  configDir: string
}

// ============================================================================
// Profile Loader
// ============================================================================

export class ProfileLoader {
  private readonly configDir: string
  private profiles: Map<string, ProfileConfig> = new Map()
  private loaded = false

  constructor(config: ProfileLoaderConfig) {
    this.configDir = config.configDir
  }

  /**
   * 加载配置文件
   */
  async load(): Promise<void> {
    const schemaPath = path.join(this.configDir, 'config.schema.yaml')

    try {
      const content = await fs.readFile(schemaPath, 'utf-8')
      const schema = parseYaml(content) as ConfigSchema

      this.profiles.clear()
      for (const profile of schema.profiles ?? []) {
        this.profiles.set(profile.name, profile)
      }

      this.loaded = true
    } catch (error) {
      // 如果文件不存在，使用默认配置
      if (isNotFoundError(error)) {
        console.warn(`Config file not found: ${schemaPath}, using default profile`)
        this.profiles.set('default', getDefaultProfile())
        this.loaded = true
      } else {
        throw error
      }
    }
  }

  /**
   * 获取 Profile
   */
  getProfile(name: string): ProfileConfig | null {
    if (!this.loaded) {
      throw new Error('ProfileLoader not loaded. Call load() first.')
    }
    return this.profiles.get(name) ?? null
  }

  /**
   * 列出所有 Profile 名称
   */
  listProfiles(): string[] {
    if (!this.loaded) {
      throw new Error('ProfileLoader not loaded. Call load() first.')
    }
    return Array.from(this.profiles.keys())
  }

  /**
   * 创建 getProfile 函数（兼容现有 API）
   */
  createProfileGetter(): (name: string) => ProfileConfig | null {
    return (name: string) => this.getProfile(name)
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * 创建 ProfileLoader 实例并加载配置
 */
export async function createProfileLoader(configDir: string): Promise<ProfileLoader> {
  const loader = new ProfileLoader({ configDir })
  await loader.load()
  return loader
}

/**
 * 默认 Profile（当配置文件不存在时使用）
 */
export function getDefaultProfile(): ProfileConfig {
  return {
    name: 'default',
    managedScopes: [
      'editor',
      'workbench.colorTheme',
      'workbench.iconTheme',
      'terminal.integrated',
      'files.autoSave',
    ],
    settings: {
      'editor.fontSize': 14,
      'editor.tabSize': 2,
      'editor.formatOnSave': true,
      'editor.defaultFormatter': 'esbenp.prettier-vscode',
      'files.autoSave': 'onFocusChange',
    },
  }
}

// ============================================================================
// Helpers
// ============================================================================

function isNotFoundError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}
