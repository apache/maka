import { z } from "zod"

export const localeSchema = z.enum(["zh-CN", "en-US"])
export type AdminLocale = z.infer<typeof localeSchema>

export const permissionCodeSchema = z.string().min(1)
export type PermissionCode = z.infer<typeof permissionCodeSchema>

export const menuTypeSchema = z.enum(["directory", "page", "button"])
export type MenuType = z.infer<typeof menuTypeSchema>

export const userSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  displayName: z.string().min(1),
  email: z.string().min(1),
  enabled: z.boolean(),
  roles: z.array(z.string().min(1)),
  permissions: z.array(permissionCodeSchema),
})
export type AdminUser = z.infer<typeof userSchema>

export const roleSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  permissions: z.array(permissionCodeSchema),
})
export type AdminRole = z.infer<typeof roleSchema>

export type MenuItem = {
  id: string
  type?: MenuType
  title: string
  path: string
  icon?: string
  order: number
  permission?: PermissionCode
  children?: MenuItem[]
}

export const menuItemSchema: z.ZodType<MenuItem> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    type: menuTypeSchema.default("page"),
    title: z.string().min(1),
    path: z.string(),
    icon: z.string().optional(),
    order: z.number().int(),
    permission: permissionCodeSchema.optional(),
    children: z.array(menuItemSchema).optional(),
  }),
)

export const loginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(6),
})
export type LoginRequest = z.infer<typeof loginRequestSchema>

export const changePasswordRequestSchema = z.object({
  oldPassword: z.string().min(6),
  newPassword: z.string().min(6),
})
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>

export const paginationQuerySchema = z.object({
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(10),
  keyword: z.string().optional(),
})
export type PaginationQuery = z.infer<typeof paginationQuerySchema>

export type PaginatedResponse<T> = {
  items: T[]
  page: number
  pageSize: number
  total: number
}

export const auditLogSchema = z.object({
  id: z.string().min(1),
  actor: z.string().min(1),
  action: z.string().min(1),
  resource: z.string().min(1),
  detail: z.string().optional(),
  createdAt: z.string(),
})
export type AuditLog = z.infer<typeof auditLogSchema>

export const createUserRequestSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(6),
  displayName: z.string().min(1),
  email: z.string().min(1),
  enabled: z.boolean().default(true),
  roles: z.array(z.string().min(1)).default([]),
})
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>

export const updateUserRequestSchema = z.object({
  displayName: z.string().min(1),
  email: z.string().min(1),
  enabled: z.boolean(),
  roles: z.array(z.string().min(1)).default([]),
})
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>

export const createRoleRequestSchema = z.object({
  code: z.string().min(2),
  name: z.string().min(1),
  description: z.string().optional(),
  permissions: z.array(permissionCodeSchema),
})
export type CreateRoleRequest = z.infer<typeof createRoleRequestSchema>

export const updateRoleRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  permissions: z.array(permissionCodeSchema),
})
export type UpdateRoleRequest = z.infer<typeof updateRoleRequestSchema>

export const createMenuRequestSchema = z.object({
  parentId: z.string().min(1).nullable().optional(),
  type: menuTypeSchema,
  title: z.string().min(1),
  path: z.string(),
  icon: z.string().optional(),
  order: z.number().int(),
  permission: permissionCodeSchema.optional(),
})
export type CreateMenuRequest = z.infer<typeof createMenuRequestSchema>
export type UpdateMenuRequest = CreateMenuRequest
