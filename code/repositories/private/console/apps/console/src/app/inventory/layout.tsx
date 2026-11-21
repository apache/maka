'use client'

import { ModuleNav, type ModuleNavItem } from '@/components/ModuleNav'

const items: ModuleNavItem[] = [
  { to: '/inventory', label: '首页', exact: true },
  { to: '/inventory/marketplace', label: '交易台' },
  { to: '/inventory/catalog', label: '市价' },
  { to: '/inventory/jobs', label: '任务' },
]

export default function InventoryLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-[1720px] px-6 py-6">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <span className="text-lg font-semibold tracking-tight">库存台</span>
      </header>
      <ModuleNav items={items} className="mb-6" />
      {children}
    </div>
  )
}
