"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@ggbdpq/console-ui"
import { Input } from "@ggbdpq/console-ui"
import { PageHeader } from "@/features/admin/components/page-header"
import { adminApi, adminErrorMessage } from "@/features/admin/admin-client"
import { useAuthState } from "@/features/admin/auth-store"
import { useAdminLocale } from "@/features/admin/locale-store"
import { useTabState } from "@/features/admin/tab-store"
import type { AdminRole, AdminUser, CreateUserRequest, UpdateUserRequest } from "@/features/admin/schemas"
import { createUserRequestSchema, updateUserRequestSchema } from "@/features/admin/schemas"

const emptyCreate: CreateUserRequest = {
  username: "",
  password: "",
  displayName: "",
  email: "",
  enabled: true,
  roles: ["viewer"],
}

export function AdminUsersPage() {
  const locale = useAdminLocale((state) => state.locale)
  const canRead = useAuthState((state) => state.hasPermission("system:user:read"))
  const canCreate = useAuthState((state) => state.hasPermission("system:user:create"))
  const canUpdate = useAuthState((state) => state.hasPermission("system:user:update"))
  const canDelete = useAuthState((state) => state.hasPermission("system:user:delete"))
  const savePageState = useTabState((state) => state.savePageState)
  const getPageState = useTabState((state) => state.getPageState)
  const cached = getPageState("/admin/users")
  const [keyword, setKeyword] = useState(String(cached?.filters?.keyword ?? ""))
  const [page, setPage] = useState(cached?.page ?? 1)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [total, setTotal] = useState(0)
  const [roles, setRoles] = useState<AdminRole[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [editing, setEditing] = useState<AdminUser | null>(null)
  const [creating, setCreating] = useState(false)
  const pageSize = 8
  const zh = locale === "zh-CN"

  const load = useCallback(async () => {
    const [list, roleList] = await Promise.all([
      adminApi.listUsers({ page, pageSize, keyword: keyword || undefined }),
      adminApi.listRoles(),
    ])
    setUsers(list.items)
    setTotal(list.total)
    setRoles(roleList)
    savePageState("/admin/users", { page, pageSize, filters: { keyword } })
  }, [keyword, page, savePageState])

  useEffect(() => {
    void load()
  }, [load])

  if (!canRead) {
    return <p className="text-sm text-muted-foreground">{zh ? "当前账号没有查看此页的权限。" : "This account cannot view this page."}</p>
  }

  async function handleDelete(id: string) {
    if (!globalThis.confirm?.(zh ? "确认删除该用户？" : "Delete this user?")) return
    try {
      await adminApi.deleteUser(id)
      setMessage(zh ? "已删除" : "Deleted")
      await load()
    } catch (error) {
      setMessage(adminErrorMessage(error, locale))
    }
  }

  return (
    <div>
      <PageHeader
        title={zh ? "用户管理" : "Users"}
        description={zh ? "内置 admin 不能禁用或删除。" : "The built-in admin cannot be disabled or deleted."}
        actions={
          canCreate ? (
            <Button size="sm" onClick={() => { setCreating(true); setEditing(null) }}>
              {zh ? "新建用户" : "Create user"}
            </Button>
          ) : null
        }
      />
      <div className="mb-3 flex gap-2">
        <Input
          value={keyword}
          onChange={(event) => {
            setKeyword(event.target.value)
            setPage(1)
          }}
          placeholder={zh ? "搜索用户名、姓名、邮箱" : "Search username, name, email"}
        />
      </div>
      {message ? <p className="mb-3 text-sm text-muted-foreground">{message}</p> : null}
      {creating || editing ? (
        <UserForm
          locale={locale}
          roles={roles}
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
              <th className="px-3 py-2 font-medium">{zh ? "用户名" : "Username"}</th>
              <th className="px-3 py-2 font-medium">{zh ? "姓名" : "Name"}</th>
              <th className="px-3 py-2 font-medium">{zh ? "角色" : "Roles"}</th>
              <th className="px-3 py-2 font-medium">{zh ? "状态" : "Status"}</th>
              <th className="px-3 py-2 font-medium">{zh ? "操作" : "Actions"}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="border-t">
                <td className="px-3 py-2">{user.username}</td>
                <td className="px-3 py-2">{user.displayName}</td>
                <td className="px-3 py-2">{user.roles.join(", ")}</td>
                <td className="px-3 py-2">{user.enabled ? (zh ? "启用" : "Enabled") : (zh ? "停用" : "Disabled")}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-2">
                    {canUpdate ? (
                      <Button size="sm" variant="outline" onClick={() => { setEditing(user); setCreating(false) }}>
                        {zh ? "编辑" : "Edit"}
                      </Button>
                    ) : null}
                    {canDelete ? (
                      <Button size="sm" variant="destructive" onClick={() => void handleDelete(user.id)}>
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
      <Pagination page={page} pageSize={pageSize} total={total} onPage={setPage} locale={locale} />
    </div>
  )
}

function UserForm({
  locale,
  roles,
  initial,
  onCancel,
  onSaved,
}: {
  locale: "zh-CN" | "en-US"
  roles: AdminRole[]
  initial: AdminUser | null
  onCancel: () => void
  onSaved: () => Promise<void>
}) {
  const zh = locale === "zh-CN"
  const [form, setForm] = useState({
    username: initial?.username ?? "",
    password: "",
    displayName: initial?.displayName ?? "",
    email: initial?.email ?? "",
    enabled: initial?.enabled ?? true,
    roles: initial?.roles ?? ["viewer"],
  })
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setError(null)
    try {
      if (initial) {
        const payload: UpdateUserRequest = updateUserRequestSchema.parse({
          displayName: form.displayName,
          email: form.email,
          enabled: form.enabled,
          roles: form.roles,
        })
        await adminApi.updateUser(initial.id, payload)
        if (form.password.length >= 6) await adminApi.resetUserPassword(initial.id, form.password)
      } else {
        const payload = createUserRequestSchema.parse({
          ...emptyCreate,
          ...form,
        })
        await adminApi.createUser(payload)
      }
      await onSaved()
    } catch (caught) {
      setError(adminErrorMessage(caught, locale))
    }
  }

  return (
    <form
      className="mb-4 grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <Field label={zh ? "用户名" : "Username"}>
        <Input value={form.username} disabled={Boolean(initial)} onChange={(e) => setForm((c) => ({ ...c, username: e.target.value }))} />
      </Field>
      <Field label={zh ? "密码" : "Password"}>
        <Input type="password" value={form.password} onChange={(e) => setForm((c) => ({ ...c, password: e.target.value }))} />
      </Field>
      <Field label={zh ? "姓名" : "Display name"}>
        <Input value={form.displayName} onChange={(e) => setForm((c) => ({ ...c, displayName: e.target.value }))} />
      </Field>
      <Field label="Email">
        <Input value={form.email} onChange={(e) => setForm((c) => ({ ...c, email: e.target.value }))} />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((c) => ({ ...c, enabled: e.target.checked }))} />
        {zh ? "启用" : "Enabled"}
      </label>
      <Field label={zh ? "角色" : "Roles"}>
        <div className="flex flex-wrap gap-2">
          {roles.map((role) => (
            <label key={role.id} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={form.roles.includes(role.code)}
                onChange={(e) => {
                  setForm((current) => ({
                    ...current,
                    roles: e.target.checked
                      ? [...current.roles, role.code]
                      : current.roles.filter((code) => code !== role.code),
                  }))
                }}
              />
              {role.name}
            </label>
          ))}
        </div>
      </Field>
      {error ? <p className="sm:col-span-2 text-sm text-destructive">{error}</p> : null}
      <div className="sm:col-span-2 flex gap-2">
        <Button type="submit" size="sm">{zh ? "保存" : "Save"}</Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>{zh ? "取消" : "Cancel"}</Button>
      </div>
    </form>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm font-medium">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  )
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
  locale,
}: {
  page: number
  pageSize: number
  total: number
  onPage: (page: number) => void
  locale: "zh-CN" | "en-US"
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const zh = locale === "zh-CN"
  return (
    <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
      <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        {zh ? "上一页" : "Prev"}
      </Button>
      <span>
        {page} / {pages} · {total}
      </span>
      <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        {zh ? "下一页" : "Next"}
      </Button>
    </div>
  )
}
