'use client'

import { ModuleNav, type ModuleNavItem } from '@/components/ModuleNav'

// 配置台外壳：跟随全局主题（基座 token），品牌名与左侧导航「配置台」对应。
const navItems: ModuleNavItem[] = [
  { to: '/agentops', label: '总览', exact: true },
  { to: '/agentops/runs', label: '运行记录' },
  { to: '/agentops/ccpage', label: 'Claude Code' },
]

export default function AgentopsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-background">
        <div className="mx-auto px-6 py-4">
          <div className="flex items-center gap-8">
            <h1 className="text-xl font-bold tracking-tight">配置台</h1>
            <ModuleNav items={navItems} className="border-b-0 pb-0" />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1720px] px-6 py-8">{children}</main>
    </div>
  )
}
