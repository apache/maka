'use client'

import { AppShell } from '@/components/governance/layout/AppShell'

// 治理台自带工作台外壳（Sidebar + Header），全出血渲染。
export default function GovernanceLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>
}
