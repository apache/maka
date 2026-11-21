import * as path from 'node:path'
/**
 * Spec Parser Service
 * 负责扫描和读取 .kiro/specs/ 目录下的 spec 文档
 */

import type { SpecDocument, SpecCompleteness } from '@ggbdpq/console-shared'

/**
 * 文件系统适配器接口
 * 用于抽象文件系统操作，便于测试
 */
export interface FileSystemAdapter {
  /** 检查路径是否存在 */
  exists(path: string): Promise<boolean>

  /** 检查路径是否为目录 */
  isDirectory(path: string): Promise<boolean>

  /** 读取目录内容 */
  readDir(path: string): Promise<readonly string[]>

  /** 读取文件内容 */
  readFile(path: string): Promise<string>
}

/**
 * Spec 扫描结果
 */
export interface SpecScanResult {
  /** 找到的 spec 名称列表 */
  readonly specs: readonly string[]

  /** 警告信息 */
  readonly warnings: readonly string[]
}

/**
 * Spec 读取结果
 */
export type SpecReadResult =
  | { readonly success: true; readonly data: SpecDocument }
  | { readonly success: false; readonly error: string }

/**
 * 扫描 specs 目录，返回所有 spec 名称
 * @param specsDir specs 目录路径（如 .kiro/specs）
 * @param fs 文件系统适配器
 */
export async function scanSpecs(
  specsDir: string,
  fs: FileSystemAdapter
): Promise<SpecScanResult> {
  const warnings: string[] = []

  // 检查目录是否存在
  const exists = await fs.exists(specsDir)
  if (!exists) {
    warnings.push(`specs 目录不存在: ${specsDir}`)
    return { specs: [], warnings }
  }

  // 检查是否为目录
  const isDir = await fs.isDirectory(specsDir)
  if (!isDir) {
    warnings.push(`路径不是目录: ${specsDir}`)
    return { specs: [], warnings }
  }

  // 读取目录内容
  const entries = await fs.readDir(specsDir)

  // 过滤出目录（排除文件和隐藏目录）
  const specs: string[] = []
  for (const entry of entries) {
    if (entry.startsWith('.')) {
      continue // 跳过隐藏文件/目录
    }

    const entryPath = `${specsDir}/${entry}`
    const entryIsDir = await fs.isDirectory(entryPath)
    if (entryIsDir) {
      specs.push(entry)
    }
  }

  return { specs, warnings }
}

/**
 * 读取单个 spec 的完整文档
 * @param specPath spec 目录路径
 * @param fs 文件系统适配器
 */
export async function readSpec(
  specPath: string,
  fs: FileSystemAdapter
): Promise<SpecReadResult> {
  // 检查目录是否存在
  const exists = await fs.exists(specPath)
  if (!exists) {
    return { success: false, error: `spec 目录不存在: ${specPath}` }
  }

  // 提取 spec 名称
  // 兼容 Windows 反斜杠与 POSIX 斜杠（原版仅按 '/' 切分，Windows 下 name 退化成整条路径）
    const name = path.basename(specPath)

  // 尝试读取各个文件
  const requirementsPath = `${specPath}/requirements.md`
  const designPath = `${specPath}/design.md`
  const tasksPath = `${specPath}/tasks.md`

  const [requirementsExists, designExists, tasksExists] = await Promise.all([
    fs.exists(requirementsPath),
    fs.exists(designPath),
    fs.exists(tasksPath),
  ])

  // 读取存在的文件内容
  const [requirements, design, tasks] = await Promise.all([
    requirementsExists ? fs.readFile(requirementsPath) : Promise.resolve(null),
    designExists ? fs.readFile(designPath) : Promise.resolve(null),
    tasksExists ? fs.readFile(tasksPath) : Promise.resolve(null),
  ])

  const completeness: SpecCompleteness = {
    hasRequirements: requirementsExists,
    hasDesign: designExists,
    hasTasks: tasksExists,
  }

  const document: SpecDocument = {
    name,
    path: specPath,
    requirements,
    design,
    tasks,
    completeness,
  }

  return { success: true, data: document }
}

/**
 * 扫描并读取所有 specs
 * @param specsDir specs 目录路径
 * @param fs 文件系统适配器
 */
export async function readAllSpecs(
  specsDir: string,
  fs: FileSystemAdapter
): Promise<{
  readonly specs: readonly SpecDocument[]
  readonly warnings: readonly string[]
}> {
  const scanResult = await scanSpecs(specsDir, fs)
  const warnings: string[] = [...scanResult.warnings]
  const specs: SpecDocument[] = []

  for (const specName of scanResult.specs) {
    const specPath = `${specsDir}/${specName}`
    const readResult = await readSpec(specPath, fs)

    if (readResult.success) {
      specs.push(readResult.data)

      // 检查完整性并添加警告
      const { completeness } = readResult.data
      if (!completeness.hasRequirements) {
        warnings.push(`${specName}: 缺少 requirements.md`)
      }
      if (!completeness.hasDesign) {
        warnings.push(`${specName}: 缺少 design.md`)
      }
      if (!completeness.hasTasks) {
        warnings.push(`${specName}: 缺少 tasks.md`)
      }
    } else {
      warnings.push(readResult.error)
    }
  }

  return { specs, warnings }
}

/**
 * 检查 spec 完整性
 */
export function isSpecComplete(spec: SpecDocument): boolean {
  return (
    spec.completeness.hasRequirements &&
    spec.completeness.hasDesign &&
    spec.completeness.hasTasks
  )
}

/**
 * 获取缺失文件列表
 */
export function getMissingFiles(spec: SpecDocument): readonly string[] {
  const missing: string[] = []

  if (!spec.completeness.hasRequirements) {
    missing.push('requirements.md')
  }
  if (!spec.completeness.hasDesign) {
    missing.push('design.md')
  }
  if (!spec.completeness.hasTasks) {
    missing.push('tasks.md')
  }

  return missing
}
