// UI Pages / Layout Components 测试
// Next App Router 形态：页面在 app/governance/<分区>/page.tsx（default 导出），
// 布局组件在 @/components/governance/layout/ 下。
import { describe, it, expect } from 'vitest'

const ROUTES = [
  ['DashboardPage', '@/app/governance/page'],
  ['SpecPage', '@/app/governance/specs/page'],
  ['PRDPage', '@/app/governance/prd/page'],
  ['ProgressPage', '@/app/governance/progress/page'],
  ['IterationPage', '@/app/governance/iterations/page'],
  ['MilestonePage', '@/app/governance/milestones/page'],
  ['CompliancePage', '@/app/governance/compliance/page'],
  ['AuditPage', '@/app/governance/audit/page'],
] as const

describe('UI Pages', () => {
  it('所有页面组件可被导入', async () => {
    for (const [, route] of ROUTES) {
      const mod = await import(route)
      expect(mod.default, route).toBeDefined()
    }
  })

  it.each(ROUTES)('%s 是函数组件', async (name, route) => {
    const mod = await import(route)
    expect(typeof mod.default).toBe('function')
  })
})

describe('Layout Components', () => {
  it('AppShell 组件可被导入', async () => {
    const { AppShell } = await import('@/components/governance/layout/AppShell')
    expect(AppShell).toBeDefined()
    expect(typeof AppShell).toBe('function')
  })

  it('TopNav 组件可被导入', async () => {
    const { TopNav } = await import('@/components/governance/layout/TopNav')
    expect(TopNav).toBeDefined()
    expect(typeof TopNav).toBe('function')
  })
})
