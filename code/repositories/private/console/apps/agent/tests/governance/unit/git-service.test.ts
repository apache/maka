/**
 * GitService 测试
 *
 * 覆盖：
 * - Git 可用/不可用状态
 * - Commit 列表获取
 * - 单个 commit 获取
 * - 文件内容获取
 * - 不可验证结果处理
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  MockGitService,
  createUnverifiableResult,
  createSuccessResult,
  isGitQuerySuccess,
  getGitQueryData,
  parseGitLogLine,
} from '@/server/governance/services'
import type { GitCommit, GitFile } from '@ggbdpq/console-shared'

describe('GitService 工具函数', () => {
  describe('createUnverifiableResult', () => {
    it('应创建不可验证结果', () => {
      const result = createUnverifiableResult<string>('Git 不可用')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.unverifiable).toBe(true)
        expect(result.reason).toBe('Git 不可用')
      }
    })
  })

  describe('createSuccessResult', () => {
    it('应创建成功结果', () => {
      const data = { sha: 'abc123', message: 'test' }
      const result = createSuccessResult(data)

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(data)
      }
    })
  })

  describe('isGitQuerySuccess', () => {
    it('应正确识别成功结果', () => {
      const success = createSuccessResult('data')
      const failure = createUnverifiableResult<string>('reason')

      expect(isGitQuerySuccess(success)).toBe(true)
      expect(isGitQuerySuccess(failure)).toBe(false)
    })
  })

  describe('getGitQueryData', () => {
    it('成功结果应返回数据', () => {
      const result = createSuccessResult('test-data')
      expect(getGitQueryData(result)).toBe('test-data')
    })

    it('失败结果应返回 undefined', () => {
      const result = createUnverifiableResult<string>('reason')
      expect(getGitQueryData(result)).toBeUndefined()
    })
  })

  describe('parseGitLogLine', () => {
    it('应解析有效的 git log 行', () => {
      const line = 'abc123|John Doe|2026-01-12T10:00:00+08:00|feat: add feature'
      const commit = parseGitLogLine(line)

      expect(commit).not.toBeNull()
      if (commit) {
        expect(commit.sha).toBe('abc123')
        expect(commit.author).toBe('John Doe')
        expect(commit.message).toBe('feat: add feature')
        expect(commit.date).toBeInstanceOf(Date)
      }
    })

    it('应处理 message 中包含 | 的情况', () => {
      const line = 'abc123|John|2026-01-12T10:00:00+08:00|feat: add | operator'
      const commit = parseGitLogLine(line)

      expect(commit).not.toBeNull()
      if (commit) {
        expect(commit.message).toBe('feat: add | operator')
      }
    })

    it('不完整行应返回 null', () => {
      expect(parseGitLogLine('abc123|John')).toBeNull()
      expect(parseGitLogLine('abc123')).toBeNull()
      expect(parseGitLogLine('')).toBeNull()
    })

    it('无效日期应返回 null', () => {
      const line = 'abc123|John|invalid-date|message'
      expect(parseGitLogLine(line)).toBeNull()
    })
  })
})

describe('MockGitService', () => {
  let service: MockGitService

  beforeEach(() => {
    service = new MockGitService()
  })

  describe('isAvailable', () => {
    it('默认应返回 true', async () => {
      expect(await service.isAvailable()).toBe(true)
    })

    it('设置不可用后应返回 false', async () => {
      service.setAvailable(false)
      expect(await service.isAvailable()).toBe(false)
    })
  })

  describe('getCommits', () => {
    const mockCommits: GitCommit[] = [
      { sha: 'aaa', author: 'A', date: new Date('2026-01-12'), message: 'first', files: [] },
      { sha: 'bbb', author: 'B', date: new Date('2026-01-11'), message: 'second', files: [] },
      { sha: 'ccc', author: 'C', date: new Date('2026-01-10'), message: 'third', files: [] },
    ]

    beforeEach(() => {
      service.setCommits(mockCommits)
    })

    it('应返回所有 commits', async () => {
      const result = await service.getCommits()

      expect(isGitQuerySuccess(result)).toBe(true)
      if (isGitQuerySuccess(result)) {
        expect(result.data).toHaveLength(3)
      }
    })

    it('应支持 limit 参数', async () => {
      const result = await service.getCommits(2)

      expect(isGitQuerySuccess(result)).toBe(true)
      if (isGitQuerySuccess(result)) {
        expect(result.data).toHaveLength(2)
        const data0 = result.data[0]
        const data1 = result.data[1]
        if (data0 && data1) {
          expect(data0.sha).toBe('aaa')
          expect(data1.sha).toBe('bbb')
        }
      }
    })

    it('Git 不可用时应返回 unverifiable', async () => {
      service.setAvailable(false)
      const result = await service.getCommits()

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.unverifiable).toBe(true)
        expect(result.reason).toContain('不可用')
      }
    })
  })

  describe('getCommit', () => {
    beforeEach(() => {
      service.setCommits([
        { sha: 'abc123def', author: 'A', date: new Date(), message: 'test', files: [] },
      ])
    })

    it('应通过完整 sha 找到 commit', async () => {
      const result = await service.getCommit('abc123def')

      expect(isGitQuerySuccess(result)).toBe(true)
      if (isGitQuerySuccess(result)) {
        const commit = result.data
        expect(commit.sha).toBe('abc123def')
      }
    })

    it('应通过短 sha 找到 commit', async () => {
      const result = await service.getCommit('abc123')

      expect(isGitQuerySuccess(result)).toBe(true)
      if (isGitQuerySuccess(result)) {
        const commit = result.data
        expect(commit.sha).toBe('abc123def')
      }
    })

    it('未找到应返回 unverifiable', async () => {
      const result = await service.getCommit('notfound')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.unverifiable).toBe(true)
        expect(result.reason).toContain('未找到')
      }
    })

    it('Git 不可用时应返回 unverifiable', async () => {
      service.setAvailable(false)
      const result = await service.getCommit('abc123')

      expect(result.success).toBe(false)
    })
  })

  describe('getFileAtCommit', () => {
    beforeEach(() => {
      service.setFileContent('abc123:README.md', '# Test README')
    })

    it('应返回指定文件内容', async () => {
      const result = await service.getFileAtCommit('abc123', 'README.md')

      expect(isGitQuerySuccess(result)).toBe(true)
      if (isGitQuerySuccess(result)) {
        expect(result.data).toBe('# Test README')
      }
    })

    it('未找到文件应返回 unverifiable', async () => {
      const result = await service.getFileAtCommit('abc123', 'notfound.txt')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.unverifiable).toBe(true)
      }
    })

    it('Git 不可用时应返回 unverifiable', async () => {
      service.setAvailable(false)
      const result = await service.getFileAtCommit('abc123', 'README.md')

      expect(result.success).toBe(false)
    })
  })

  describe('getCurrentFileContent', () => {
    beforeEach(() => {
      service.setFileContent('HEAD:src/main.ts', 'console.log("hello")')
    })

    it('应返回当前文件内容', async () => {
      const result = await service.getCurrentFileContent('src/main.ts')

      expect(isGitQuerySuccess(result)).toBe(true)
      if (isGitQuerySuccess(result)) {
        expect(result.data).toBe('console.log("hello")')
      }
    })

    it('未找到文件应返回 unverifiable', async () => {
      const result = await service.getCurrentFileContent('notfound.ts')

      expect(result.success).toBe(false)
    })

    it('Git 不可用时应返回 unverifiable', async () => {
      service.setAvailable(false)
      const result = await service.getCurrentFileContent('src/main.ts')

      expect(result.success).toBe(false)
    })
  })

  describe('getFilesInCommit', () => {
    const mockFiles: GitFile[] = [
      { path: 'src/index.ts', status: 'added' },
      { path: 'README.md', status: 'modified' },
    ]

    beforeEach(() => {
      service.setCommitFiles('abc123', mockFiles)
    })

    it('应返回 commit 的文件列表', async () => {
      const result = await service.getFilesInCommit('abc123')

      expect(isGitQuerySuccess(result)).toBe(true)
      if (isGitQuerySuccess(result)) {
        expect(result.data).toHaveLength(2)
        const firstFile = result.data[0]
        if (firstFile) {
          expect(firstFile.path).toBe('src/index.ts')
          expect(firstFile.status).toBe('added')
        }
      }
    })

    it('未找到应返回 unverifiable', async () => {
      const result = await service.getFilesInCommit('notfound')

      expect(result.success).toBe(false)
    })

    it('Git 不可用时应返回 unverifiable', async () => {
      service.setAvailable(false)
      const result = await service.getFilesInCommit('abc123')

      expect(result.success).toBe(false)
    })
  })

  describe('getCurrentBranch', () => {
    it('默认应返回 main', async () => {
      const result = await service.getCurrentBranch()

      expect(isGitQuerySuccess(result)).toBe(true)
      if (isGitQuerySuccess(result)) {
        expect(result.data).toBe('main')
      }
    })

    it('应返回设置的分支名', async () => {
      service.setBranch('feature/test')
      const result = await service.getCurrentBranch()

      expect(isGitQuerySuccess(result)).toBe(true)
      if (isGitQuerySuccess(result)) {
        expect(result.data).toBe('feature/test')
      }
    })

    it('Git 不可用时应返回 unverifiable', async () => {
      service.setAvailable(false)
      const result = await service.getCurrentBranch()

      expect(result.success).toBe(false)
    })
  })

  describe('getRepoRoot', () => {
    it('默认应返回 /mock/repo', async () => {
      const result = await service.getRepoRoot()

      expect(isGitQuerySuccess(result)).toBe(true)
      if (isGitQuerySuccess(result)) {
        expect(result.data).toBe('/mock/repo')
      }
    })

    it('应返回设置的仓库根目录', async () => {
      service.setRepoRoot('/custom/path')
      const result = await service.getRepoRoot()

      expect(isGitQuerySuccess(result)).toBe(true)
      if (isGitQuerySuccess(result)) {
        expect(result.data).toBe('/custom/path')
      }
    })

    it('Git 不可用时应返回 unverifiable', async () => {
      service.setAvailable(false)
      const result = await service.getRepoRoot()

      expect(result.success).toBe(false)
    })
  })

  describe('reset', () => {
    it('应重置所有 mock 数据', async () => {
      // 设置各种数据
      service.setAvailable(false)
      service.setCommits([{ sha: 'abc', author: 'A', date: new Date(), message: 'test', files: [] }])
      service.setBranch('custom')
      service.setRepoRoot('/custom')
      service.setFileContent('HEAD:test.txt', 'content')
      service.setCommitFiles('abc', [{ path: 'test.ts', status: 'added' }])

      // 重置
      service.reset()

      // 验证
      expect(await service.isAvailable()).toBe(true)
      expect(isGitQuerySuccess(await service.getCommits())).toBe(true)
      expect(getGitQueryData(await service.getCommits())).toHaveLength(0)
      expect(getGitQueryData(await service.getCurrentBranch())).toBe('main')
      expect(getGitQueryData(await service.getRepoRoot())).toBe('/mock/repo')
    })
  })
})

describe('GitService 边界情况', () => {
  let service: MockGitService

  beforeEach(() => {
    service = new MockGitService()
  })

  describe('空 commits 列表', () => {
    it('应正确处理空列表', async () => {
      const result = await service.getCommits()

      expect(isGitQuerySuccess(result)).toBe(true)
      if (isGitQuerySuccess(result)) {
        expect(result.data).toEqual([])
      }
    })
  })

  describe('空文件内容', () => {
    it('应正确处理空字符串内容', async () => {
      service.setFileContent('HEAD:empty.txt', '')
      const result = await service.getCurrentFileContent('empty.txt')

      expect(isGitQuerySuccess(result)).toBe(true)
      if (isGitQuerySuccess(result)) {
        expect(result.data).toBe('')
      }
    })
  })

  describe('特殊字符处理', () => {
    it('应正确处理包含特殊字符的路径', async () => {
      service.setFileContent('HEAD:path/with spaces/file.txt', 'content')
      const result = await service.getCurrentFileContent('path/with spaces/file.txt')

      expect(isGitQuerySuccess(result)).toBe(true)
      if (isGitQuerySuccess(result)) {
        expect(result.data).toBe('content')
      }
    })

    it('应正确处理中文路径', async () => {
      service.setFileContent('HEAD:文档/测试.md', '# 测试')
      const result = await service.getCurrentFileContent('文档/测试.md')

      expect(isGitQuerySuccess(result)).toBe(true)
      if (isGitQuerySuccess(result)) {
        expect(result.data).toBe('# 测试')
      }
    })
  })

  describe('类型安全', () => {
    it('isGitQuerySuccess 应提供正确的类型守卫', async () => {
      const result = await service.getCurrentBranch()

      // TypeScript 应该能够正确推断类型
      if (isGitQuerySuccess(result)) {
        // 在这个分支中，result.data 应该是 string
        const branch: string = result.data
        expect(typeof branch).toBe('string')
      }
    })
  })
})
