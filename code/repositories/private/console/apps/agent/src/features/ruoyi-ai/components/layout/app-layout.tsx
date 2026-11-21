import type { ReactNode } from 'react'
import {
  Activity,
  BookOpen,
  Bot,
  Database,
  LayoutDashboard,
  MessagesSquare,
  Plug,
  Settings,
  Wrench,
} from 'lucide-react'
import { Link, Outlet, useLocation } from 'react-router'
import { cn } from '@/features/ruoyi-ai/lib/utils'

interface NavLeaf {
  to: string
  label: string
  icon: ReactNode
}

const OVERVIEW: NavLeaf[] = [{ to: '/', label: '概览', icon: <LayoutDashboard className="size-4" /> }]

const DIALOG: NavLeaf[] = [
  { to: '/knowledge', label: '知识管理', icon: <BookOpen className="size-4" /> },
  { to: '/chat', label: '聊天消息', icon: <MessagesSquare className="size-4" /> },
]

const PLACEHOLDER: { label: string; icon: ReactNode }[] = [
  { label: '智能体管理', icon: <Bot className="size-4" /> },
  { label: 'MCP 管理', icon: <Plug className="size-4" /> },
  { label: '系统管理', icon: <Settings className="size-4" /> },
  { label: '系统监控', icon: <Activity className="size-4" /> },
  { label: '系统工具', icon: <Wrench className="size-4" /> },
]

function Leaf({ item, active }: { item: NavLeaf; active: boolean }) {
  return (
    <Link
      to={item.to}
      className={cn(
        'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
        active ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      )}
    >
      {item.icon}
      {item.label}
    </Link>
  )
}

export default function AppLayout() {
  const { pathname } = useLocation()
  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to))

  return (
    <div className="flex h-dvh bg-background text-foreground">
      <aside className="hidden w-56 shrink-0 flex-col border-r bg-card/40 md:flex">
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <div className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
            <Bot className="size-4" />
          </div>
          <span className="text-sm font-semibold">RuoYi AI Admin</span>
        </div>

        <nav className="flex-1 space-y-4 overflow-y-auto p-2">
          <div className="space-y-1">
            {OVERVIEW.map((item) => (
              <Leaf key={item.to} item={item} active={isActive(item.to)} />
            ))}
          </div>

          <div className="space-y-1">
            <p className="px-3 py-1 text-xs text-muted-foreground">对话管理</p>
            {DIALOG.map((item) => (
              <Leaf key={item.to} item={item} active={isActive(item.to)} />
            ))}
          </div>

          <div className="space-y-1">
            {PLACEHOLDER.map((item) => (
              <div
                key={item.label}
                title="本次不做：与向量库/向量模型无关"
                className="flex cursor-not-allowed items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground/50"
              >
                {item.icon}
                {item.label}
              </div>
            ))}
          </div>
        </nav>

        <div className="border-t px-4 py-3 text-[11px] leading-5 text-muted-foreground">
          本地演示 · 数据存于浏览器
          <br />
          <Database className="mr-1 inline size-3" />
          暴力余弦索引
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
          <div className="text-sm text-muted-foreground">
            {pathname === '/' ? '概览' : pathname.startsWith('/knowledge') ? '对话管理 / 知识管理' : '对话管理 / 聊天消息'}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded-full border px-2 py-0.5">React 19 · Vite 8</span>
            <span className="rounded-full border px-2 py-0.5">Zod 契约</span>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
