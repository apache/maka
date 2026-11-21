import type { AdminRole, AdminUser, AuditLog, MenuItem, PermissionCode } from "@/features/admin/schemas"

export type SeedUser = AdminUser & {
  password: string
}

export const allPermissions: PermissionCode[] = [
  "dashboard:view",
  "system:view",
  "system:user:read",
  "system:user:create",
  "system:user:update",
  "system:user:delete",
  "system:role:read",
  "system:role:update",
  "system:menu:read",
  "system:menu:update",
  "audit:read",
]

export const seedRoles: AdminRole[] = [
  {
    id: "role_admin",
    code: "admin",
    name: "Administrator",
    description: "Full system access",
    permissions: allPermissions,
  },
  {
    id: "role_manager",
    code: "manager",
    name: "Manager",
    description: "Can inspect and update core system data",
    permissions: [
      "dashboard:view",
      "system:view",
      "system:user:read",
      "system:user:update",
      "system:role:read",
      "system:menu:read",
      "audit:read",
    ],
  },
  {
    id: "role_viewer",
    code: "viewer",
    name: "Viewer",
    description: "Read-only dashboard access",
    permissions: ["dashboard:view"],
  },
]

export const seedUsers: SeedUser[] = [
  {
    id: "user_admin",
    username: "admin",
    password: "admin123",
    displayName: "Administrator",
    email: "admin@example.com",
    enabled: true,
    roles: ["admin"],
    permissions: [],
  },
  {
    id: "user_manager",
    username: "manager",
    password: "manager123",
    displayName: "Manager",
    email: "manager@example.com",
    enabled: true,
    roles: ["manager"],
    permissions: [],
  },
  {
    id: "user_viewer",
    username: "viewer",
    password: "viewer123",
    displayName: "Viewer",
    email: "viewer@example.com",
    enabled: true,
    roles: ["viewer"],
    permissions: [],
  },
]

export const seedMenus: MenuItem[] = [
  {
    id: "dashboard",
    type: "page",
    title: "Dashboard",
    path: "/admin",
    icon: "LayoutDashboard",
    order: 1,
    permission: "dashboard:view",
  },
  {
    id: "system",
    type: "directory",
    title: "System",
    path: "/admin/system",
    icon: "Settings",
    order: 20,
    permission: "system:view",
    children: [
      {
        id: "users",
        type: "page",
        title: "Users",
        path: "/admin/users",
        icon: "Users",
        order: 21,
        permission: "system:user:read",
      },
      {
        id: "roles",
        type: "page",
        title: "Roles",
        path: "/admin/roles",
        icon: "ShieldCheck",
        order: 22,
        permission: "system:role:read",
      },
      {
        id: "menus",
        type: "page",
        title: "Menus",
        path: "/admin/menus",
        icon: "PanelLeft",
        order: 23,
        permission: "system:menu:read",
      },
    ],
  },
  {
    id: "audit",
    type: "page",
    title: "Audit Logs",
    path: "/admin/audit-logs",
    icon: "History",
    order: 30,
    permission: "audit:read",
  },
]

export const seedAuditLogs: AuditLog[] = [
  {
    id: "audit_seed",
    actor: "system",
    action: "system.seed",
    resource: "database",
    detail: "Seed data initialized",
    createdAt: "2026-06-08T00:00:00.000Z",
  },
]
