"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { useShallow } from "zustand/react/shallow"
import {
  History,
  Languages,
  LayoutDashboard,
  LogOut,
  Menu,
  PanelLeft,
  Settings,
  ShieldCheck,
  User,
  Users,
} from "lucide-react"
import { Button } from "@ggbdpq/console-ui"
import { cn } from "@ggbdpq/console-ui"
import type { AdminLocale, MenuItem } from "@/features/admin/schemas"
import { flattenMenus } from "@/features/admin/rbac"
import { authStore, useAuthState } from "@/features/admin/auth-store"
import { tabStore, useTabState } from "@/features/admin/tab-store"
import { useAdminLocale } from "@/features/admin/locale-store"

const iconMap = {
  LayoutDashboard,
  Settings,
  Users,
  ShieldCheck,
  PanelLeft,
  History,
}

const titleMap: Record<AdminLocale, Record<string, string>> = {
  "zh-CN": {
    Dashboard: "仪表盘",
    System: "系统管理",
    Users: "用户管理",
    Roles: "角色管理",
    Menus: "菜单管理",
    "Audit Logs": "操作日志",
    Profile: "个人中心",
  },
  "en-US": {
    Dashboard: "Dashboard",
    System: "System",
    Users: "Users",
    Roles: "Roles",
    Menus: "Menus",
    "Audit Logs": "Audit Logs",
    Profile: "Profile",
  },
}

function localizeTitle(locale: AdminLocale, title: string) {
  return titleMap[locale]?.[title] ?? title
}

export function AdminGate({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  if (pathname === "/admin/login") return children
  return <AdminShell>{children}</AdminShell>
}

export function AdminShell({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const locale = useAdminLocale((state) => state.locale)
  const setLocale = useAdminLocale((state) => state.setLocale)
  const { accessToken, user, menus, hydrated } = useAuthState(
    useShallow((state) => ({
      accessToken: state.accessToken,
      user: state.user,
      menus: state.menus,
      hydrated: state.hydrated,
    })),
  )
  const { tabs, closeTab, setActivePath } = useTabState(
    useShallow((state) => ({
      tabs: state.tabs,
      closeTab: state.closeTab,
      setActivePath: state.setActivePath,
    })),
  )
  const [collapsed, setCollapsed] = useState(false)

  const allMenus = useMemo(() => flattenMenus(menus), [menus])
  const currentTitle = useMemo(() => {
    if (pathname === "/admin/profile") return localizeTitle(locale, "Profile")
    const current = allMenus.find((menu) => menu.path === pathname)
    return current ? localizeTitle(locale, current.title) : localizeTitle(locale, "Dashboard")
  }, [allMenus, locale, pathname])

  useEffect(() => {
    authStore.getState().hydrateFromStorage()
    tabStore.getState().hydrateFromStorage()
  }, [])

  useEffect(() => {
    if (!hydrated) return
    if (!authStore.getState().accessToken) {
      router.replace("/admin/login")
    }
  }, [accessToken, hydrated, router])

  useEffect(() => {
    if (accessToken && pathname.startsWith("/admin") && pathname !== "/admin/login") {
      tabStore.getState().openTab({ path: pathname, title: currentTitle })
    }
  }, [accessToken, currentTitle, pathname])

  function logout() {
    const confirmed =
      globalThis.confirm?.(locale === "zh-CN" ? "确认退出当前账号？" : "Log out of this account?") ?? true
    if (!confirmed) return
    authStore.getState().clearSession()
    tabStore.getState().clearAll()
    router.replace("/admin/login")
  }

  if (!hydrated || !accessToken || !user) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted-foreground">
        {locale === "zh-CN" ? "正在进入后台…" : "Loading console…"}
      </div>
    )
  }

  const otherLocale: AdminLocale = locale === "zh-CN" ? "en-US" : "zh-CN"

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] border-t bg-background">
      <aside className={cn("border-r bg-card transition-all", collapsed ? "w-16" : "w-60")}>
        <div className="flex h-14 items-center gap-2 border-b px-3">
          <div className="flex size-8 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
            A
          </div>
          {collapsed ? null : (
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">权限控制台</div>
              <div className="truncate text-xs text-muted-foreground">离线 RBAC 演示</div>
            </div>
          )}
        </div>
        <nav className="p-2">
          {menus.map((menu) => (
            <MenuGroup key={menu.id} menu={menu} locale={locale} collapsed={collapsed} pathname={pathname} />
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b bg-card px-4">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" aria-label="折叠侧栏" onClick={() => setCollapsed((value) => !value)}>
              <Menu className="size-4" />
            </Button>
            <div>
              <div className="text-sm font-semibold">{currentTitle}</div>
              <div className="text-xs text-muted-foreground">{user.displayName}</div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" asChild>
              <Link href="/admin/profile">
                <User className="size-4" />
                {localizeTitle(locale, "Profile")}
              </Link>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setLocale(otherLocale)}>
              <Languages className="size-4" />
              {otherLocale}
            </Button>
            <Button variant="secondary" size="sm" onClick={logout}>
              <LogOut className="size-4" />
              {locale === "zh-CN" ? "退出" : "Logout"}
            </Button>
          </div>
        </header>
        <div className="flex h-10 items-center gap-1 overflow-x-auto border-b bg-card px-2">
          {tabs.map((tab) => (
            <Link
              key={tab.path}
              href={tab.path}
              onClick={() => setActivePath(tab.path)}
              className={cn(
                "inline-flex h-7 items-center gap-2 rounded-md border px-2 text-xs",
                tab.path === pathname
                  ? "border-primary text-primary"
                  : "border-border text-muted-foreground",
              )}
            >
              {tab.title}
              {tabs.length > 1 ? (
                <button
                  type="button"
                  aria-label={`关闭 ${tab.title}`}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    closeTab(tab.path)
                    const next = tabStore.getState().activePath
                    if (next && next !== pathname) router.push(next)
                  }}
                >
                  ×
                </button>
              ) : null}
            </Link>
          ))}
        </div>
        <main className="min-h-0 flex-1 overflow-auto p-4">{children}</main>
      </div>
    </div>
  )
}

function MenuGroup({
  menu,
  locale,
  collapsed,
  pathname,
}: {
  menu: MenuItem
  locale: AdminLocale
  collapsed: boolean
  pathname: string
}) {
  const Icon = iconMap[menu.icon as keyof typeof iconMap] ?? LayoutDashboard
  const active = pathname === menu.path

  return (
    <div className="mb-1">
      <Link
        href={menu.path}
        className={cn(
          "flex h-9 items-center gap-2 rounded-md px-2 text-sm",
          active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/60",
        )}
      >
        <Icon className="size-4" />
        {collapsed ? null : <span className="truncate">{localizeTitle(locale, menu.title)}</span>}
      </Link>
      {!collapsed && menu.children?.length ? (
        <div className="ml-4 mt-1 border-l pl-2">
          {menu.children.map((child) => (
            <MenuGroup key={child.id} menu={child} locale={locale} collapsed={collapsed} pathname={pathname} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
