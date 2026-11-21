"use client"

import { useState } from "react"
import { Button } from "@ggbdpq/console-ui"
import { Input } from "@ggbdpq/console-ui"
import { PageHeader } from "@/features/admin/components/page-header"
import { adminApi, adminErrorMessage } from "@/features/admin/admin-client"
import { useAuthState } from "@/features/admin/auth-store"
import { useAdminLocale } from "@/features/admin/locale-store"
import { changePasswordRequestSchema } from "@/features/admin/schemas"

export function AdminProfilePage() {
  const locale = useAdminLocale((state) => state.locale)
  const user = useAuthState((state) => state.user)
  const [oldPassword, setOldPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const zh = locale === "zh-CN"

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setMessage(null)
    try {
      const payload = changePasswordRequestSchema.parse({ oldPassword, newPassword })
      await adminApi.changePassword(payload)
      setOldPassword("")
      setNewPassword("")
      setMessage(zh ? "密码已更新" : "Password updated")
    } catch (caught) {
      setError(adminErrorMessage(caught, locale))
    }
  }

  if (!user) return null

  return (
    <div className="max-w-lg">
      <PageHeader
        title={zh ? "个人中心" : "Profile"}
        description={zh ? "改密会校验当前密码，并写入审计日志。" : "Password changes verify the current password and write an audit log."}
      />
      <dl className="mb-4 grid gap-2 rounded-xl border bg-card p-4 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">{zh ? "用户名" : "Username"}</dt>
          <dd>{user.username}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">{zh ? "姓名" : "Name"}</dt>
          <dd>{user.displayName}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Email</dt>
          <dd>{user.email}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">{zh ? "角色" : "Roles"}</dt>
          <dd>{user.roles.join(", ")}</dd>
        </div>
      </dl>
      <form onSubmit={submit} className="space-y-3 rounded-xl border bg-card p-4">
        <label className="block text-sm font-medium">
          {zh ? "当前密码" : "Current password"}
          <Input className="mt-1" type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} />
        </label>
        <label className="block text-sm font-medium">
          {zh ? "新密码" : "New password"}
          <Input className="mt-1" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
        </label>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
        <Button type="submit" size="sm">{zh ? "更新密码" : "Update password"}</Button>
      </form>
    </div>
  )
}
