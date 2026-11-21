/**
 * Spec Parser Service 测试
 * 使用 fixtures 覆盖各种边界情况
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import {
  scanSpecs,
  readSpec,
  readAllSpecs,
  isSpecComplete,
  getMissingFiles,
  type FileSystemAdapter,
} from '@/server/governance/services/spec-parser'

const FIXTURES_DIR = join(__dirname, 'fixtures/specs')

/**
 * 创建基于真实文件系统的适配器（用于 fixtures 测试）
 */
function createRealFSAdapter(): FileSystemAdapter {
  return {
    async exists(path: string): Promise<boolean> {
      return existsSync(path)
    },
    async isDirectory(path: string): Promise<boolean> {
      try {
        return statSync(path).isDirectory()
      } catch {
        return false
      }
    },
    async readDir(path: string): Promise<readonly string[]> {
      return readdirSync(path)
    },
    async readFile(path: string): Promise<string> {
      return readFileSync(path, 'utf-8')
    },
  }
}

/**
 * 创建 Mock 文件系统适配器
 */
function createMockFSAdapter(files: Record<string, string | null>): FileSystemAdapter {
  const dirs = new Set<string>()

  // 从文件路径推断目录
  for (const path of Object.keys(files)) {
    const parts = path.split('/')
    let current = ''
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i]!
      dirs.add(current)
    }
  }

  return {
    async exists(path: string): Promise<boolean> {
      return dirs.has(path) || path in files
    },
    async isDirectory(path: string): Promise<boolean> {
      return dirs.has(path)
    },
    async readDir(path: string): Promise<readonly string[]> {
      const entries = new Set<string>()
      const prefix = path + '/'
      for (const filePath of Object.keys(files)) {
        if (filePath.startsWith(prefix)) {
          const rest = filePath.slice(prefix.length)
          const firstPart = rest.split('/')[0]
          if (firstPart) {
            entries.add(firstPart)
          }
        }
      }
      for (const dir of dirs) {
        if (dir.startsWith(prefix)) {
          const rest = dir.slice(prefix.length)
          const firstPart = rest.split('/')[0]
          if (firstPart) {
            entries.add(firstPart)
          }
        }
      }
      return Array.from(entries)
    },
    async readFile(path: string): Promise<string> {
      const content = files[path]
      if (content === undefined || content === null) {
        throw new Error(`File not found: ${path}`)
      }
      return content
    },
  }
}

describe('scanSpecs', () => {
  it('扫描 fixtures/specs 目录', async () => {
    const fs = createRealFSAdapter()
    const result = await scanSpecs(FIXTURES_DIR, fs)

    expect(result.specs).toContain('complete')
    expect(result.specs).toContain('missing-requirements')
    expect(result.specs).toContain('missing-design')
    expect(result.specs).toContain('missing-tasks')
    expect(result.specs).toContain('empty')
    expect(result.warnings).toHaveLength(0)
  })

  it('目录不存在返回警告', async () => {
    const fs = createMockFSAdapter({})
    const result = await scanSpecs('non-existent', fs)

    expect(result.specs).toHaveLength(0)
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings[0]).toContain('不存在')
  })

  it('排除隐藏目录', async () => {
    const fs = createMockFSAdapter({
      'specs/visible/requirements.md': 'content',
      'specs/.hidden/requirements.md': 'content',
    })
    const result = await scanSpecs('specs', fs)

    expect(result.specs).toContain('visible')
    expect(result.specs).not.toContain('.hidden')
  })
})

describe('readSpec', () => {
  it('读取完整 spec', async () => {
    const fs = createRealFSAdapter()
    const result = await readSpec(join(FIXTURES_DIR, 'complete'), fs)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.name).toBe('complete')
      expect(result.data.requirements).not.toBeNull()
      expect(result.data.design).not.toBeNull()
      expect(result.data.tasks).not.toBeNull()
      expect(result.data.completeness.hasRequirements).toBe(true)
      expect(result.data.completeness.hasDesign).toBe(true)
      expect(result.data.completeness.hasTasks).toBe(true)
    }
  })

  it('读取缺少 requirements 的 spec', async () => {
    const fs = createRealFSAdapter()
    const result = await readSpec(join(FIXTURES_DIR, 'missing-requirements'), fs)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.requirements).toBeNull()
      expect(result.data.design).not.toBeNull()
      expect(result.data.tasks).not.toBeNull()
      expect(result.data.completeness.hasRequirements).toBe(false)
      expect(result.data.completeness.hasDesign).toBe(true)
      expect(result.data.completeness.hasTasks).toBe(true)
    }
  })

  it('读取缺少 design 的 spec', async () => {
    const fs = createRealFSAdapter()
    const result = await readSpec(join(FIXTURES_DIR, 'missing-design'), fs)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.requirements).not.toBeNull()
      expect(result.data.design).toBeNull()
      expect(result.data.tasks).not.toBeNull()
      expect(result.data.completeness.hasDesign).toBe(false)
    }
  })

  it('读取缺少 tasks 的 spec', async () => {
    const fs = createRealFSAdapter()
    const result = await readSpec(join(FIXTURES_DIR, 'missing-tasks'), fs)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.requirements).not.toBeNull()
      expect(result.data.design).not.toBeNull()
      expect(result.data.tasks).toBeNull()
      expect(result.data.completeness.hasTasks).toBe(false)
    }
  })

  it('读取空目录 spec', async () => {
    const fs = createRealFSAdapter()
    const result = await readSpec(join(FIXTURES_DIR, 'empty'), fs)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.requirements).toBeNull()
      expect(result.data.design).toBeNull()
      expect(result.data.tasks).toBeNull()
      expect(result.data.completeness.hasRequirements).toBe(false)
      expect(result.data.completeness.hasDesign).toBe(false)
      expect(result.data.completeness.hasTasks).toBe(false)
    }
  })

  it('不存在的 spec 返回错误', async () => {
    const fs = createRealFSAdapter()
    const result = await readSpec(join(FIXTURES_DIR, 'non-existent'), fs)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('不存在')
    }
  })
})

describe('readAllSpecs', () => {
  it('读取所有 specs 并生成警告', async () => {
    const fs = createRealFSAdapter()
    const result = await readAllSpecs(FIXTURES_DIR, fs)

    expect(result.specs.length).toBeGreaterThan(0)

    // 应该有关于缺失文件的警告
    expect(result.warnings.some((w) => w.includes('缺少'))).toBe(true)
  })
})

describe('isSpecComplete', () => {
  it('完整 spec 返回 true', async () => {
    const fs = createRealFSAdapter()
    const result = await readSpec(join(FIXTURES_DIR, 'complete'), fs)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(isSpecComplete(result.data)).toBe(true)
    }
  })

  it('不完整 spec 返回 false', async () => {
    const fs = createRealFSAdapter()
    const result = await readSpec(join(FIXTURES_DIR, 'missing-requirements'), fs)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(isSpecComplete(result.data)).toBe(false)
    }
  })
})

describe('getMissingFiles', () => {
  it('完整 spec 返回空数组', async () => {
    const fs = createRealFSAdapter()
    const result = await readSpec(join(FIXTURES_DIR, 'complete'), fs)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(getMissingFiles(result.data)).toHaveLength(0)
    }
  })

  it('缺少 requirements 的 spec 返回 requirements.md', async () => {
    const fs = createRealFSAdapter()
    const result = await readSpec(join(FIXTURES_DIR, 'missing-requirements'), fs)

    expect(result.success).toBe(true)
    if (result.success) {
      const missing = getMissingFiles(result.data)
      expect(missing).toContain('requirements.md')
      expect(missing).not.toContain('design.md')
      expect(missing).not.toContain('tasks.md')
    }
  })

  it('空 spec 返回所有三个文件', async () => {
    const fs = createRealFSAdapter()
    const result = await readSpec(join(FIXTURES_DIR, 'empty'), fs)

    expect(result.success).toBe(true)
    if (result.success) {
      const missing = getMissingFiles(result.data)
      expect(missing).toHaveLength(3)
      expect(missing).toContain('requirements.md')
      expect(missing).toContain('design.md')
      expect(missing).toContain('tasks.md')
    }
  })
})
