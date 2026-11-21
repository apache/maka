import type { AdminRole, MenuItem, PermissionCode } from "@/features/admin/schemas"
import type { SeedUser } from "@/features/admin/seed"

export function collectPermissionsForUser(user: Pick<SeedUser, "roles">, roles: AdminRole[]): PermissionCode[] {
  const roleMap = new Map(roles.map((role) => [role.code, role]))
  const permissionSet = new Set<PermissionCode>()

  for (const roleCode of user.roles) {
    const role = roleMap.get(roleCode)
    if (!role) continue
    for (const permission of role.permissions) permissionSet.add(permission)
  }

  return [...permissionSet].sort()
}

export function getVisibleMenus(menus: MenuItem[], permissions: PermissionCode[]): MenuItem[] {
  const permissionSet = new Set(permissions)

  return menus
    .map((menu) => {
      if (menu.type === "button") return null
      const children = menu.children ? getVisibleMenus(menu.children, permissions) : undefined
      const canSeeSelf = !menu.permission || permissionSet.has(menu.permission)
      const canSeeChildren = Boolean(children?.length)
      if (!canSeeSelf && !canSeeChildren) return null
      return {
        ...menu,
        ...(children?.length ? { children } : { children: undefined }),
      }
    })
    .filter((menu): menu is MenuItem => menu !== null)
    .sort((a, b) => a.order - b.order)
}

export function userCan(user: Pick<SeedUser, "roles">, roles: AdminRole[], permission: PermissionCode): boolean {
  return collectPermissionsForUser(user, roles).includes(permission)
}

export function flattenMenus(menus: MenuItem[]): MenuItem[] {
  return menus.flatMap((menu) => [menu, ...(menu.children ? flattenMenus(menu.children) : [])])
}

export function findMenuParentId(
  menus: MenuItem[],
  id: string,
  parentId: string | null = null,
): string | null | undefined {
  for (const menu of menus) {
    if (menu.id === id) return parentId
    if (!menu.children?.length) continue
    const nested = findMenuParentId(menu.children, id, menu.id)
    if (nested !== undefined) return nested
  }
  return undefined
}
