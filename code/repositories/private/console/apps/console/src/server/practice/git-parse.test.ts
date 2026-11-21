import { describe, expect, it } from 'vitest'
import { parseBranchRefs, parseCommitDetails, parseShaList } from './git'

describe('parseBranchRefs', () => {
  it('本地与远程分支合并为展示名并去重，过滤裸远程与 HEAD，同名本地引用优先', () => {
    const out = [
      'refs/heads/main',
      'refs/heads/feature/v1.7.0',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin',
      'refs/remotes/origin/main',
      'refs/remotes/origin/feature/v1.7.0',
      'refs/remotes/origin/develop',
    ].join('\n')
    const refs = parseBranchRefs(out)
    expect(refs.map((r) => r.name)).toEqual(['main', 'feature/v1.7.0', 'develop'])
    expect(refs.find((r) => r.name === 'main')?.ref).toBe('refs/heads/main')
    expect(refs.find((r) => r.name === 'develop')?.ref).toBe('refs/remotes/origin/develop')
  })

  it('空输入返回空数组', () => {
    expect(parseBranchRefs('')).toEqual([])
  })
})

describe('parseShaList', () => {
  it('只保留 40 位十六进制 sha 行', () => {
    const out = [
      '9059a0bb5844d88b6a8ab6a9b6b1c30e5ee1a001',
      '',
      'not-a-sha',
      '92b2bbaa1144d88b6a8ab6a9b6b1c30e5ee1a002',
    ].join('\n')
    expect(parseShaList(out)).toHaveLength(2)
  })
})

describe('parseCommitDetails', () => {
  it('解析 \\x01 分隔的记录与 numstat 行，二进制文件计 0', () => {
    const out = [
      '\x019059a0bb5844d88b6a8ab6a9b6b1c30e5ee1a001\u0000关天豪\u0000802165@clife.cn\u00002026-08-20T10:00:00+08:00\u0000```fix(ui): 修复白屏',
      '12\t3\tsrc/pages/index/index.tsx',
      '5\t2\tsrc/pages/index/index.config.ts',
      '-\t-\tsrc/assets/logo.png',
      '\x0192b2bbaa1144d88b6a8ab6a9b6b1c30e5ee1a002\u0000关天豪\u0000802165@clife.cn\u00002026-08-21T11:30:00+08:00\u0000feat(home): 新增入口',
    ].join('\n')

    const details = parseCommitDetails(out)
    expect(details).toHaveLength(2)
    expect(details[0]).toMatchObject({
      sha: '9059a0bb5844d88b6a8ab6a9b6b1c30e5ee1a001',
      authorName: '关天豪',
      authorEmail: '802165@clife.cn',
      authoredAt: '2026-08-20T10:00:00+08:00',
      rawSubject: '```fix(ui): 修复白屏',
    })
    expect(details[0]?.files).toEqual([
      { path: 'src/pages/index/index.tsx', insertions: 12, deletions: 3 },
      { path: 'src/pages/index/index.config.ts', insertions: 5, deletions: 2 },
      { path: 'src/assets/logo.png', insertions: 0, deletions: 0 },
    ])
    expect(details[1]?.files).toEqual([])
  })

  it('subject 含 \\t 或空格不破坏字段解析', () => {
    const out = '\x01abc\u0000n\u0000e\u00002026-01-01T00:00:00Z\u0000fix: 标题\t含制表符'
    const details = parseCommitDetails(out)
    expect(details[0]?.rawSubject).toBe('fix: 标题\t含制表符')
  })
})
