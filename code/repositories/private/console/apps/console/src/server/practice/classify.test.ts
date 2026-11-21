import { describe, expect, it } from 'vitest'
import { classifyCommit, cleanSubject, extractFixScope, extractTapdBug } from './classify'

describe('cleanSubject', () => {
  it('剥掉 AI 残留的 markdown 围栏前缀', () => {
    expect(cleanSubject('```fix(serviceComplete): 护理报告文本两行截断并按组对齐')).toBe(
      'fix(serviceComplete): 护理报告文本两行截断并按组对齐',
    )
    expect(cleanSubject('```feat(workbench): 增加导出')).toBe('feat(workbench): 增加导出')
  })

  it('剥掉尾部围栏', () => {
    expect(cleanSubject('修复登录态丢失```')).toBe('修复登录态丢失')
  })

  it('整条都是围栏时给占位符，不留垃圾字符', () => {
    expect(cleanSubject('```')).toBe('(无有效提交信息)')
    expect(cleanSubject('```ts')).toBe('(无有效提交信息)')
  })

  it('正常标题原样返回', () => {
    expect(cleanSubject('fix: 更新依赖版本')).toBe('fix: 更新依赖版本')
    expect(cleanSubject('  页面跳转优化加载2  ')).toBe('页面跳转优化加载2')
  })
})

describe('extractTapdBug', () => {
  it('提取 --bug=N@tapd 单号', () => {
    expect(extractTapdBug('fix: 修复白屏 --bug=1080152@tapd-abc')).toBe('1080152')
  })
  it('无单号返回 null', () => {
    expect(extractTapdBug('feat: 新增导出')).toBeNull()
  })
})

describe('classifyCommit', () => {
  it('merge / 平台合并提交归 other', () => {
    expect(classifyCommit('Merge branch "feature/v1.7.0" into master')).toBe('other')
    expect(classifyCommit('合并来自 xxx 的合并请求 #16')).toBe('other')
  })

  it('conventional fix 前缀归 issue（容忍围栏残留）', () => {
    expect(classifyCommit('fix: 更新依赖版本')).toBe('issue')
    expect(classifyCommit('fix(serviceComplete): 护理报告文本两行截断并按组对齐')).toBe('issue')
    expect(classifyCommit('fix:bug修复')).toBe('issue')
    expect(classifyCommit('bugfix(workbench): 空指针')).toBe('issue')
  })

  it('conventional feat / add 前缀归 pr', () => {
    expect(classifyCommit('feat: 新增多语言')).toBe('pr')
    expect(classifyCommit('feat(BillSetting): 新增账单设置')).toBe('pr')
    expect(classifyCommit('feature/v1.7 上线私教报告')).toBe('pr')
    expect(classifyCommit('add export button')).toBe('pr')
  })

  it('中文句式动词开头按动词判', () => {
    expect(classifyCommit('修复暗色模式下看板发白')).toBe('issue')
    expect(classifyCommit('新增预约助手页面')).toBe('pr')
    expect(classifyCommit('接入云端部署的登录与会话管理')).toBe('pr')
    expect(classifyCommit('支持批量导出')).toBe('pr')
  })

  it('裸 subject 靠关键词兜底', () => {
    expect(classifyCommit('登录态偶发丢失修复')).toBe('issue')
    expect(classifyCommit('页面跳转优化加载2')).toBe('other')
    expect(classifyCommit('代码格式调整')).toBe('other')
  })

  it('前缀优先于正文关键词：fix 内提新增仍是 issue', () => {
    expect(classifyCommit('fix: 新增校验避免空指针')).toBe('issue')
  })
})

describe('extractFixScope', () => {
  it('提取 fix(scope) 的 scope', () => {
    expect(extractFixScope('fix(serviceComplete): 护理报告文本两行截断')).toBe('serviceComplete')
    expect(extractFixScope('fix(workbench): 折叠侧栏')).toBe('workbench')
  })
  it('无 scope 或非 fix 返回 null', () => {
    expect(extractFixScope('fix: 更新依赖版本')).toBeNull()
    expect(extractFixScope('feat(home): 新增入口')).toBeNull()
  })
})
