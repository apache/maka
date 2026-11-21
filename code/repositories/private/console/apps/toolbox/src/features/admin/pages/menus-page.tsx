"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@ggbdpq/console-ui"
import { Input } from "@ggbdpq/console-ui"
import { PageHeader } from "@/features/admin/components/page-header"
import { adminApi, adminErrorMessage } from "@/features/admin/admin-client"
import { findMenuParentId, flattenMenus } from "@/features/admin/rbac"
import { useAuthState } from "@/features/admin/auth-store"
import { useAdminLocale } from "@/features/admin/locale-store"
import type { MenuItem, MenuType, PermissionCode } from "@/features/admin/schemas"
import { createMenuRequestSchema } from "@/features/admin/schemas"

export function AdminMenusPage() {
  const locale = useAdminLocale((state) => state.locale)
  const canRead = useAuthState((state) => state.hasPermission("system:menu:read"))
  const canUpdate = useAuthState((state) => state.hasPermission("system:menu:update"))
  const [menus, setMenus] = useState<MenuItem[]>([])
  const [permissions, setPermissions] = useState<PermissionCode[]>([])
  const [editing, setEditing] = useState<MenuItem | null>(null)
  const [creating, setCreating] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const zh = locale === "zh-CN"
  const flat = flattenMenus(menus)

  const load = useCallback(async () => {
    const [tree, permissionList] = await Promise.all([adminApi.listManagedMenus(), adminApi.listPermissions()])
    setMenus(tree)
    setPermissions(permissionList)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (!canRead) {
    return <p className="text-sm text-muted-foreground">{zh ? "当前账号没有查看此页的权限。" : "This account cannot view this page."}</p>
  }

  async function handleDelete(id: string) {
    if (!globalThis.confirm?.(zh ? "确认删除该菜单？" : "Delete this menu?")) return
    try {
      await adminApi.deleteMenu(id)
      setMessage(zh ? "已删除" : "Deleted")
      await load()
    } catch (error) {
      setMessage(adminErrorMessage(error, locale))
    }
  }

  return (
    <div>
      <PageHeader
        title={zh ? "菜单管理" : "Menus"}
        description={zh ? "有子节点的菜单不能删除。" : "Menus with children cannot be deleted."}
        actions={
          canUpdate ? (
            <Button size="sm" onClick={() => { setCreating(true); setEditing(null) }}>
              {zh ? "新建菜单" : "Create menu"}
            </Button>
          ) : null
        }
      />
      {message ? <p className="mb-3 text-sm text-muted-foreground">{message}</p> : null}
      {creating || editing ? (
        <MenuForm
          locale={locale}
          menus={menus}
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
              <th className="px-3 py-2 font-medium">{zh ? "标题" : "Title"}</th>
              <th className="px-3 py-2 font-medium">{zh ? "路径" : "Path"}</th>
              <th className="px-3 py-2 font-medium">{zh ? "权限" : "Permission"}</th>
              <th className="px-3 py-2 font-medium">{zh ? "操作" : "Actions"}</th>
            </tr>
          </thead>
          <tbody>
            {flat.map((menu) => (
              <tr key={menu.id} className="border-t">
                <td className="px-3 py-2">{menu.title}</td>
                <td className="px-3 py-2 font-mono text-xs">{menu.path}</td>
                <td className="px-3 py-2">{menu.permission ?? "-"}</td>
                <td className="px-3 py-2">
                  <div className="flex gap-2">
                    {canUpdate ? (
                      <Button size="sm" variant="outline" onClick={() => { setEditing(menu); setCreating(false) }}>
                        {zh ? "编辑" : "Edit"}
                      </Button>
                    ) : null}
                    {canUpdate ? (
                      <Button size="sm" variant="destructive" onClick={() => void handleDelete(menu.id)}>
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

function MenuForm({
  locale,
  menus,
  permissions,
  initial,
  onCancel,
  onSaved,
}: {
  locale: "zh-CN" | "en-US"
  menus: MenuItem[]
  permissions: PermissionCode[]
  initial: MenuItem | null
  onCancel: () => void
  onSaved: () => Promise<void>
}) {
  const zh = locale === "zh-CN"
  const [form, setForm] = useState({
    parentId: initial ? (findMenuParentId(menus, initial.id) ?? "") : "",
    type: (initial?.type ?? "page") as MenuType,
    title: initial?.title ?? "",
    path: initial?.path ?? "/admin/",
    icon: initial?.icon ?? "",
    order: initial?.order ?? 40,
    permission: initial?.permission ?? "",
  })
  const [error, setError] = useState<string | null>(null)
  const flat = flattenMenus(menus)

  async function submit() {
    setError(null)
    try {
      const payload = createMenuRequestSchema.parse({
        parentId: form.parentId || null,
        type: form.type,
        title: form.title,
        path: form.path,
        icon: form.icon || undefined,
        order: Number(form.order),
        permission: form.permission || undefined,
      })
      if (initial) await adminApi.updateMenu(initial.id, payload)
      else await adminApi.createMenu(payload)
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
      <label className="block text-sm font-medium">
        {zh ? "父级" : "Parent"}
        <select
          className="mt-1 h-9 w-full rounded-md border bg-transparent px-3 text-sm"
          value={form.parentId}
          onChange={(e) => setForm((c) => ({ ...c, parentId: e.target.value }))}
        >
          <option value="">{zh ? "根节点" : "Root"}</option>
          {flat.map((menu) => (
            <option key={menu.id} value={menu.id} disabled={menu.id === initial?.id}>
              {menu.title}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm font-medium">
        {zh ? "类型" : "Type"}
        <select
          className="mt-1 h-9 w-full rounded-md border bg-transparent px-3 text-sm"
          value={form.type}
          onChange={(e) => setForm((c) => ({ ...c, type: e.target.value as MenuType }))}
        >
          <option value="directory">{zh ? "目录" : "Directory"}</option>
          <option value="page">{zh ? "页面" : "Page"}</option>
          <option value="button">{zh ? "按钮" : "Button"}</option>
        </select>
      </label>
      <label className="block text-sm font-medium">
        {zh ? "标题" : "Title"}
        <Input className="mt-1" value={form.title} onChange={(e) => setForm((c) => ({ ...c, title: e.target.value }))} />
      </label>
      <label className="block text-sm font-medium">
        {zh ? "路径" : "Path"}
        <Input className="mt-1" value={form.path} onChange={(e) => setForm((c) => ({ ...c, path: e.target.value }))} />
      </label>
      <label className="block text-sm font-medium">
        {zh ? "图标" : "Icon"}
        <Input className="mt-1" value={form.icon} onChange={(e) => setForm((c) => ({ ...c, icon: e.target.value }))} />
      </label>
      <label className="block text-sm font-medium">
        {zh ? "排序" : "Order"}
        <Input className="mt-1" type="number" value={form.order} onChange={(e) => setForm((c) => ({ ...c, order: Number(e.target.value) }))} />
      </label>
      <label className="sm:col-span-2 block text-sm font-medium">
        {zh ? "权限" : "Permission"}
        <select
          className="mt-1 h-9 w-full rounded-md border bg-transparent px-3 text-sm"
          value={form.permission}
          onChange={(e) => setForm((c) => ({ ...c, permission: e.target.value }))}
        >
          <option value="">{zh ? "无权限码" : "No permission"}</option>
          {permissions.map((permission) => (
            <option key={permission} value={permission}>
              {permission}
            </option>
          ))}
        </select>
      </label>
      {error ? <p className="sm:col-span-2 text-sm text-destructive">{error}</p> : null}
      <div className="sm:col-span-2 flex gap-2">
        <Button type="submit" size="sm">{zh ? "保存" : "Save"}</Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>{zh ? "取消" : "Cancel"}</Button>
      </div>
    </form>
  )
}
