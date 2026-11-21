"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { adminApi } from "@/features/admin/admin-client"
import { useAdminLocale } from "@/features/admin/locale-store"
import { PageHeader } from "@/features/admin/components/page-header"
import type { AuditLog } from "@/features/admin/schemas"

export function AdminDashboardPage() {
  const locale = useAdminLocale((state) => state.locale)
  const [userCount, setUserCount] = useState(0)
  const [roleCount, setRoleCount] = useState(0)
  const [menuCount, setMenuCount] = useState(0)
  const [recentLogs, setRecentLogs] = useState<AuditLog[]>([])

  useEffect(() => {
    void adminApi.getDashboardCounts().then((data) => {
      setUserCount(data.userCount)
      setRoleCount(data.roleCount)
      setMenuCount(data.menuCount)
      setRecentLogs(data.recentLogs)
    })
  }, [])

  const zh = locale === "zh-CN"

  return (
    <div>
      <PageHeader
        title={zh ? "仪表盘" : "Dashboard"}
        description={zh ? "本地权限控制台，数据存在浏览器里。" : "Local RBAC console. Data stays in the browser."}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard href="/admin/users" label={zh ? "用户" : "Users"} value={userCount} />
        <StatCard href="/admin/roles" label={zh ? "角色" : "Roles"} value={roleCount} />
        <StatCard href="/admin/menus" label={zh ? "菜单" : "Menus"} value={menuCount} />
      </div>
      <section className="mt-6 rounded-xl border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold">{zh ? "最近操作" : "Recent audit"}</h2>
        <ul className="space-y-2 text-sm">
          {recentLogs.map((log) => (
            <li key={log.id} className="flex flex-wrap justify-between gap-2 text-muted-foreground">
              <span>
                {log.actor} · {log.action} · {log.resource}
              </span>
              <time dateTime={log.createdAt}>{new Date(log.createdAt).toLocaleString("zh-CN")}</time>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function StatCard({ href, label, value }: { href: string; label: string; value: number }) {
  return (
    <Link href={href} className="rounded-xl border bg-card p-4 transition-colors hover:bg-accent">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
    </Link>
  )
}
