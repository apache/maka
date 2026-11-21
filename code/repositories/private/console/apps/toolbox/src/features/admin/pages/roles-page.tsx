"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@ggbdpq/console-ui"
import { Input } from "@ggbdpq/console-ui"
import { PageHeader } from "@/features/admin/components/page-header"
import { adminApi, adminErrorMessage } from "@/features/admin/admin-client"
import { useAuthState } from "@/features/admin/auth-store"
import { useAdminLocale } from "@/features/admin/locale-store"
import type { AdminRole, PermissionCode } from "@/features/admin/schemas"
import { createRoleRequestSchema, updateRoleRequestSchema } from "@/features/admin/schemas"

export function AdminRolesPage() {
  const locale = useAdminLocale((state) => state.locale)
  const canRead = useAuthState((state) => state.hasPermission("system:role:read"))
  const canUpdate = useAuthState((state) => state.hasPermission("system:role:update"))
  const [roles, setRoles] = useState<AdminRole[]>([])
  const [permissions, setPermissions] = useState<PermissionCode[]>([])
  const [editing, setEditing] = useState<AdminRole | null>(null)
  const [creating, setCreating] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const zh = locale === "zh-CN"

  const load = useCallback(async () => {
    const [roleList, permissionList] = await Promise.all([adminApi.listRoles(), adminApi.listPermissions()])
    setRoles(roleList)
    setPermissions(permissionList)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (!canRead) {
    return <p className="text-sm text-muted-foreground">{zh ? "当前账号没有查看此页的权限。" : "This account cannot view this page."}</p>
  }

  async function handleDelete(id: string) {
    if (!globalThis.confirm?.(zh ? "确认删除该角色？" : "Delete this role?")) return
    try {
      await adminApi.deleteRole(id)
      setMessage(zh ? "已删除" : "Deleted")
      await load()
    } catch (error) {
      setMessage(adminErrorMessage(error, locale))
    }
  }

  return (
    <div>
      <PageHeader
        title={zh ? "角色管理" : "Roles"}
        description={zh ? "内置角色不能删，被占用的角色也不能删。" : "Built-in and assigned roles cannot be deleted."}
        actions={
          canUpdate ? (
            <Button size="sm" onClick={() => { setCreating(true); setEditing(null) }}>
              {zh ? "新建角色" : "Create role"}
            </Button>
          ) : null
        }
      />
      {message ? <p className="mb-3 text-sm text-muted-foreground">{message}</p> : null}
      {creating || editing ? (
        <RoleForm
          locale={locale}
          permissions={permissions}
          initial={editing}
          onCancel={() => {
            setCreating(false)
            setEditing(null)
          }}
          onSaved={async () => {
            setCreating(false)
            setEditing(null)
            setMessage(zh ? "已保存" : "Saved")
            await load()
          }}
        />
      ) : null}
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-3 py-2 font-medium">Code</th>
              <th className="px-3 py-2 font-medium">{zh ? "名称" : "Name"}</th>
              <th className="px-3 py-2 font-medium">{zh ? "权限数" : "Permissions"}</th>
              <th className="px-3 py-2 font-medium">{zh ? "操作" : "Actions"}</th>
            </tr>
          </thead>
          <tbody>
            {roles.map((role) => (
              <tr key={role.id} className="border-t">
                <td className="px-3 py-2 font-mono">{role.code}</td>
                <td className="px-3 py-2">{role.name}</td>
                <td className="px-3 py-2">{role.permissions.length}</td>
                <td className="px-3 py-2">
                  <div className="flex gap-2">
                    {canUpdate ? (
                      <Button size="sm" variant="outline" onClick={() => { setEditing(role); setCreating(false) }}>
                        {zh ? "编辑" : "Edit"}
                      </Button>
                    ) : null}
                    {canUpdate ? (
                      <Button size="sm" variant="destructive" onClick={() => void handleDelete(role.id)}>
                        {zh ? "删除" : "Delete"}
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function RoleForm({
  locale,
  permissions,
  initial,
  onCancel,
  onSaved,
}: {
  locale: "zh-CN" | "en-US"
  permissions: PermissionCode[]
  initial: AdminRole | null
  onCancel: () => void
  onSaved: () => Promise<void>
}) {
  const zh = locale === "zh-CN"
  const [form, setForm] = useState({
    code: initial?.code ?? "",
    name: initial?.name ?? "",
    description: initial?.description ?? "",
    permissions: initial?.permissions ?? [],
  })
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setError(null)
    try {
      if (initial) {
        await adminApi.updateRole(initial.id, updateRoleRequestSchema.parse({
          name: form.name,
          description: form.description,
          permissions: form.permissions,
        }))
      } else {
        await adminApi.createRole(createRoleRequestSchema.parse(form))
      }
      await onSaved()
    } catch (caught) {
      setError(adminErrorMessage(caught, locale))
    }
  }

  return (
    <form
      className="mb-4 space-y-3 rounded-xl border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <label className="block text-sm font-medium">
        Code
        <Input className="mt-1" value={form.code} disabled={Boolean(initial)} onChange={(e) => setForm((c) => ({ ...c, code: e.target.value }))} />
      </label>
      <label className="block text-sm font-medium">
        {zh ? "名称" : "Name"}
        <Input className="mt-1" value={form.name} onChange={(e) => setForm((c) => ({ ...c, name: e.target.value }))} />
      </label>
      <label className="block text-sm font-medium">
        {zh ? "说明" : "Description"}
        <Input className="mt-1" value={form.description} onChange={(e) => setForm((c) => ({ ...c, description: e.target.value }))} />
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        {permissions.map((permission) => (
          <label key={permission} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.permissions.includes(permission)}
              onChange={(e) => {
                setForm((current) => ({
                  ...current,
                  permissions: e.target.checked
                    ? [...current.permissions, permission]
                    : current.permissions.filter((item) => item !== permission),
                }))
              }}
            />
            {permission}
          </label>
        ))}
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm">{zh ? "保存" : "Save"}</Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>{zh ? "取消" : "Cancel"}</Button>
      </div>
    </form>
  )
}
