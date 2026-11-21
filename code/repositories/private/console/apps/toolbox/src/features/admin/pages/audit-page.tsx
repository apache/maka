"use client"

import { useCallback, useEffect, useState } from "react"
import { Input } from "@ggbdpq/console-ui"
import { PageHeader } from "@/features/admin/components/page-header"
import { Pagination } from "@/features/admin/pages/users-page"
import { adminApi } from "@/features/admin/admin-client"
import { useAuthState } from "@/features/admin/auth-store"
import { useAdminLocale } from "@/features/admin/locale-store"
import { useTabState } from "@/features/admin/tab-store"
import type { AuditLog } from "@/features/admin/schemas"

export function AdminAuditPage() {
  const locale = useAdminLocale((state) => state.locale)
  const canRead = useAuthState((state) => state.hasPermission("audit:read"))
  const savePageState = useTabState((state) => state.savePageState)
  const getPageState = useTabState((state) => state.getPageState)
  const cached = getPageState("/admin/audit-logs")
  const [keyword, setKeyword] = useState(String(cached?.filters?.keyword ?? ""))
  const [page, setPage] = useState(cached?.page ?? 1)
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [total, setTotal] = useState(0)
  const pageSize = 10
  const zh = locale === "zh-CN"

  const load = useCallback(async () => {
    const result = await adminApi.listAuditLogs({ page, pageSize, keyword: keyword || undefined })
    setLogs(result.items)
    setTotal(result.total)
    savePageState("/admin/audit-logs", { page, pageSize, filters: { keyword } })
  }, [keyword, page, savePageState])

  useEffect(() => {
    void load()
  }, [load])

  if (!canRead) {
    return <p className="text-sm text-muted-foreground">{zh ? "当前账号没有查看此页的权限。" : "This account cannot view this page."}</p>
  }

  return (
    <div>
      <PageHeader
        title={zh ? "操作日志" : "Audit logs"}
        description={zh ? "登录、改密和 CRUD 都会写入本地日志。" : "Login, password changes and CRUD are recorded locally."}
      />
      <Input
        className="mb-3"
        value={keyword}
        onChange={(event) => {
          setKeyword(event.target.value)
          setPage(1)
        }}
        placeholder={zh ? "搜索操作人、动作、资源" : "Search actor, action, resource"}
      />
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-3 py-2 font-medium">{zh ? "时间" : "Time"}</th>
              <th className="px-3 py-2 font-medium">{zh ? "操作人" : "Actor"}</th>
              <th className="px-3 py-2 font-medium">{zh ? "动作" : "Action"}</th>
              <th className="px-3 py-2 font-medium">{zh ? "资源" : "Resource"}</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id} className="border-t">
                <td className="px-3 py-2 whitespace-nowrap">{new Date(log.createdAt).toLocaleString("zh-CN")}</td>
                <td className="px-3 py-2">{log.actor}</td>
                <td className="px-3 py-2 font-mono text-xs">{log.action}</td>
                <td className="px-3 py-2">{log.resource}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={page} pageSize={pageSize} total={total} onPage={setPage} locale={locale} />
    </div>
  )
}
