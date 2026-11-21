"use client"

import { PageHeader } from "@/features/admin/components/page-header"
import { useAuthState } from "@/features/admin/auth-store"
import { useAdminLocale } from "@/features/admin/locale-store"
import { seedUsers } from "@/features/admin/seed"

export function AdminSystemPage() {
  const locale = useAdminLocale((state) => state.locale)
  const canRead = useAuthState((state) => state.hasPermission("system:view"))
  const zh = locale === "zh-CN"

  if (!canRead) {
    return <p className="text-sm text-muted-foreground">{zh ? "当前账号没有查看此页的权限。" : "This account cannot view this page."}</p>
  }

  return (
    <div>
      <PageHeader
        title={zh ? "系统概览" : "System"}
        description={zh ? "这是嵌在个人主站里的离线后台演示，没有独立 API。" : "Offline admin demo inside the personal site. No separate API."}
      />
      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold">{zh ? "演示账号" : "Seed accounts"}</h2>
        <ul className="space-y-2 text-sm">
          {seedUsers.map((user) => (
            <li key={user.id} className="flex flex-wrap justify-between gap-2">
              <span>
                {user.username} · {user.roles.join(", ")}
              </span>
              <span className="font-mono text-muted-foreground">{user.password}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
