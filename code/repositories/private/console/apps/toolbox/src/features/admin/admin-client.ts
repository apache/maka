"use client"

import type {
  AdminUser,
  ChangePasswordRequest,
  CreateMenuRequest,
  CreateRoleRequest,
  CreateUserRequest,
  LoginRequest,
  PaginationQuery,
  UpdateMenuRequest,
  UpdateRoleRequest,
  UpdateUserRequest,
} from "@/features/admin/schemas"
import { loginRequestSchema } from "@/features/admin/schemas"
import { AdminRepositoryError, InMemoryAdminRepository } from "@/features/admin/repository"
import { authStore, type AdminSession } from "@/features/admin/auth-store"

const REPO_KEY = "ggbdpq-admin:repo:v1"

let repo: InMemoryAdminRepository | null = null

export function getAdminRepository(): InMemoryAdminRepository {
  if (repo) return repo
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(REPO_KEY)
      if (raw) {
        repo = new InMemoryAdminRepository(JSON.parse(raw))
        return repo
      }
    } catch {
      /* fall through to seed */
    }
  }
  repo = new InMemoryAdminRepository()
  persistAdminRepository()
  return repo
}

function persistAdminRepository() {
  if (typeof window === "undefined" || !repo) return
  window.localStorage.setItem(REPO_KEY, JSON.stringify(repo.snapshot()))
}

async function withPersist<T>(work: (current: InMemoryAdminRepository) => Promise<T>): Promise<T> {
  const current = getAdminRepository()
  const result = await work(current)
  persistAdminRepository()
  return result
}

export function adminErrorMessage(error: unknown, locale: "zh-CN" | "en-US"): string {
  const code = error instanceof AdminRepositoryError ? error.code : null
  const zh: Record<string, string> = {
    USERNAME_EXISTS: "用户名已存在",
    ROLE_NOT_FOUND: "角色不存在",
    BUILT_IN_USER_PROTECTED: "内置管理员不能禁用或删除",
    ROLE_CODE_EXISTS: "角色编码已存在",
    PERMISSION_NOT_FOUND: "权限码不存在",
    BUILT_IN_ROLE_PROTECTED: "内置角色不能删除",
    ROLE_IN_USE: "角色仍被用户占用，不能删除",
    MENU_PARENT_NOT_FOUND: "父级菜单不存在",
    MENU_HAS_CHILDREN: "有子节点的菜单不能删除",
    INVALID_OLD_PASSWORD: "当前密码不正确",
    INVALID_CREDENTIALS: "用户名或密码不正确",
  }
  const en: Record<string, string> = {
    USERNAME_EXISTS: "Username already exists",
    ROLE_NOT_FOUND: "Role does not exist",
    BUILT_IN_USER_PROTECTED: "The built-in admin cannot be disabled or deleted",
    ROLE_CODE_EXISTS: "Role code already exists",
    PERMISSION_NOT_FOUND: "Permission does not exist",
    BUILT_IN_ROLE_PROTECTED: "Built-in roles cannot be deleted",
    ROLE_IN_USE: "Assigned roles cannot be deleted",
    MENU_PARENT_NOT_FOUND: "Parent menu does not exist",
    MENU_HAS_CHILDREN: "Menus with children cannot be deleted",
    INVALID_OLD_PASSWORD: "Current password is incorrect",
    INVALID_CREDENTIALS: "Invalid username or password",
  }
  const table = locale === "zh-CN" ? zh : en
  if (code && table[code]) return table[code]
  return locale === "zh-CN" ? "操作失败" : "Operation failed"
}

export async function loginAdmin(input: LoginRequest): Promise<AdminSession> {
  const credentials = loginRequestSchema.parse(input)
  return withPersist(async (current) => {
    const user = await current.findUserByUsername(credentials.username)
    if (!user || !user.enabled || !(await current.verifyPassword(user, credentials.password))) {
      throw new AdminRepositoryError("INVALID_CREDENTIALS", "Invalid credentials")
    }
    const profile = await current.getUserProfile(user)
    const menus = await current.getVisibleMenusForUser(user)
    await current.createAuditLog({
      actor: user.username,
      action: "auth.login",
      resource: "session",
    })
    return {
      accessToken: `demo.${user.id}`,
      user: profile,
      menus,
    }
  })
}

function actorName() {
  return authStore.getState().user?.username ?? "anonymous"
}

async function refreshSessionMenus() {
  const sessionUser = authStore.getState().user
  if (!sessionUser) return
  const current = getAdminRepository()
  const fresh = await current.findUserById(sessionUser.id)
  if (!fresh) return
  const profile = await current.getUserProfile(fresh)
  const menus = await current.getVisibleMenusForUser(fresh)
  authStore.getState().setSession({
    accessToken: authStore.getState().accessToken ?? `demo.${fresh.id}`,
    user: profile,
    menus,
  })
}

export const adminApi = {
  listUsers: (query: PaginationQuery) => getAdminRepository().listUsers(query),
  createUser: (input: CreateUserRequest) =>
    withPersist(async (current) => {
      const created = await current.createUser(input)
      await current.createAuditLog({
        actor: actorName(),
        action: "user.create",
        resource: created.username,
      })
      return created
    }),
  updateUser: (id: string, input: UpdateUserRequest) =>
    withPersist(async (current) => {
      const updated = await current.updateUser(id, input)
      if (updated) {
        await current.createAuditLog({
          actor: actorName(),
          action: "user.update",
          resource: updated.username,
        })
        await refreshSessionMenus()
      }
      return updated
    }),
  deleteUser: (id: string) =>
    withPersist(async (current) => {
      const user = await current.findUserById(id)
      const ok = await current.deleteUser(id)
      if (ok && user) {
        await current.createAuditLog({
          actor: actorName(),
          action: "user.delete",
          resource: user.username,
        })
      }
      return ok
    }),
  resetUserPassword: (id: string, password: string) =>
    withPersist(async (current) => {
      const ok = await current.resetUserPassword(id, password)
      if (ok) {
        const user = await current.findUserById(id)
        await current.createAuditLog({
          actor: actorName(),
          action: "user.reset_password",
          resource: user?.username ?? id,
        })
      }
      return ok
    }),
  listRoles: () => getAdminRepository().listRoles(),
  listPermissions: () => getAdminRepository().listPermissions(),
  createRole: (input: CreateRoleRequest) =>
    withPersist(async (current) => {
      const created = await current.createRole(input)
      await current.createAuditLog({
        actor: actorName(),
        action: "role.create",
        resource: created.code,
      })
      return created
    }),
  updateRole: (id: string, input: UpdateRoleRequest) =>
    withPersist(async (current) => {
      const updated = await current.updateRole(id, input)
      if (updated) {
        await current.createAuditLog({
          actor: actorName(),
          action: "role.update",
          resource: updated.code,
        })
        await refreshSessionMenus()
      }
      return updated
    }),
  deleteRole: (id: string) =>
    withPersist(async (current) => {
      const roles = await current.listRoles()
      const role = roles.find((item) => item.id === id)
      const ok = await current.deleteRole(id)
      if (ok && role) {
        await current.createAuditLog({
          actor: actorName(),
          action: "role.delete",
          resource: role.code,
        })
      }
      return ok
    }),
  listManagedMenus: () => getAdminRepository().listManagedMenus(),
  createMenu: (input: CreateMenuRequest) =>
    withPersist(async (current) => {
      const created = await current.createMenu(input)
      await current.createAuditLog({
        actor: actorName(),
        action: "menu.create",
        resource: created.title,
      })
      await refreshSessionMenus()
      return created
    }),
  updateMenu: (id: string, input: UpdateMenuRequest) =>
    withPersist(async (current) => {
      const updated = await current.updateMenu(id, input)
      if (updated) {
        await current.createAuditLog({
          actor: actorName(),
          action: "menu.update",
          resource: updated.title,
        })
        await refreshSessionMenus()
      }
      return updated
    }),
  deleteMenu: (id: string) =>
    withPersist(async (current) => {
      const ok = await current.deleteMenu(id)
      if (ok) {
        await current.createAuditLog({
          actor: actorName(),
          action: "menu.delete",
          resource: id,
        })
        await refreshSessionMenus()
      }
      return ok
    }),
  listAuditLogs: (query: PaginationQuery) => getAdminRepository().listAuditLogs(query),
  changePassword: (input: ChangePasswordRequest) =>
    withPersist(async (current) => {
      const user = authStore.getState().user
      if (!user) return false
      const ok = await current.changeUserPassword(user.id, input.oldPassword, input.newPassword)
      if (ok) {
        await current.createAuditLog({
          actor: user.username,
          action: "auth.change_password",
          resource: "profile",
        })
      }
      return ok
    }),
  getDashboardCounts: async () => {
    const current = getAdminRepository()
    const [users, roles, menus, logs] = await Promise.all([
      current.listUsers({ page: 1, pageSize: 1 }),
      current.listRoles(),
      current.listManagedMenus(),
      current.listAuditLogs({ page: 1, pageSize: 6 }),
    ])
    return {
      userCount: users.total,
      roleCount: roles.length,
      menuCount: menus.length,
      recentLogs: logs.items,
    }
  },
}

export type PublicAdminUser = AdminUser
