/**
 * 应用外壳布局组件
 * 顶部：Header（品牌/搜索/主题）+ TopNav（水平菜单）
 * 下方：内容区
 */
import { TopNav } from './TopNav'
import { Header } from './Header'

export interface AppShellProps {
  /** 主题切换插槽 */
  themeSlot?: React.ReactNode
  /** 页面内容（Next 布局注入） */
  children: React.ReactNode
}

/**
 * 应用外壳布局
 */
export function AppShell({ themeSlot, children }: AppShellProps) {
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* 顶部 Header */}
      <Header themeSlot={themeSlot} />

      {/* 顶部水平菜单 */}
      <TopNav />

      {/* 主内容区域 */}
      <main className="flex-1 overflow-auto p-6">{children}</main>
    </div>
  )
}
