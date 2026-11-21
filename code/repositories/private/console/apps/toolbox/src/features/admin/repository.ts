import type {
  AdminRole,
  AdminUser,
  AuditLog,
  CreateMenuRequest,
  CreateRoleRequest,
  CreateUserRequest,
  MenuItem,
  PaginatedResponse,
  PaginationQuery,
  PermissionCode,
  UpdateMenuRequest,
  UpdateRoleRequest,
  UpdateUserRequest
} from "@/features/admin/schemas"
import { collectPermissionsForUser, getVisibleMenus } from "@/features/admin/rbac"
import { allPermissions, seedAuditLogs, seedMenus, seedRoles, seedUsers, type SeedUser } from "@/features/admin/seed"

export type AdminRepositoryErrorCode =
  | 'USERNAME_EXISTS'
  | 'ROLE_NOT_FOUND'
  | 'BUILT_IN_USER_PROTECTED'
  | 'ROLE_CODE_EXISTS'
  | 'PERMISSION_NOT_FOUND'
  | 'BUILT_IN_ROLE_PROTECTED'
  | 'ROLE_IN_USE'
  | 'MENU_PARENT_NOT_FOUND'
  | 'MENU_HAS_CHILDREN'
  | 'INVALID_OLD_PASSWORD'
  | 'INVALID_CREDENTIALS';

/** Domain error raised by repository mutations so API routes can return stable error codes. */
export class AdminRepositoryError extends Error {
  /** Stable machine-readable error code returned by API handlers. */
  readonly code: AdminRepositoryErrorCode;

  /** Creates a repository domain error with a public code and message. */
  constructor(code: AdminRepositoryErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** In-memory repository used by the first runnable admin skeleton and tests. */
export class InMemoryAdminRepository {
  /** User records including demo plaintext passwords. */
  private readonly users: SeedUser[];
  /** Role records used for RBAC permission aggregation. */
  private readonly roles: AdminRole[];
  /** Dynamic menu tree records filtered by RBAC. */
  private readonly menus: MenuItem[];
  /** Append-only operation log entries stored in memory. */
  private readonly auditLogs: AuditLog[];

  /** Creates an isolated repository instance from seed data or test overrides. */
  constructor(input?: {
    users?: SeedUser[];
    roles?: AdminRole[];
    menus?: MenuItem[];
    auditLogs?: AuditLog[];
  }) {
    this.users = structuredClone(input?.users ?? seedUsers);
    this.roles = structuredClone(input?.roles ?? seedRoles);
    this.menus = structuredClone(input?.menus ?? seedMenus);
    this.auditLogs = structuredClone(input?.auditLogs ?? seedAuditLogs);
  }

  /** Finds a user by username for login flows. */
  async findUserByUsername(username: string): Promise<SeedUser | undefined> {
    return this.users.find((user) => user.username === username);
  }

  /** Finds a user by stable id for JWT authentication. */
  async findUserById(id: string): Promise<SeedUser | undefined> {
    return this.users.find((user) => user.id === id);
  }

  /** Verifies the provided password against the demo seed password. */
  async verifyPassword(user: SeedUser, password: string): Promise<boolean> {
    return user.password === password;
  }

  /** Changes a user's own password after verifying the current password. */
  async changeUserPassword(id: string, oldPassword: string, newPassword: string): Promise<boolean> {
    /** User record selected by the stable route id. */
    const user = await this.findUserById(id);
    if (!user) return false;

    if (!(await this.verifyPassword(user, oldPassword))) {
      throw new AdminRepositoryError('INVALID_OLD_PASSWORD', 'Current password is incorrect');
    }

    user.password = newPassword;
    return true;
  }

  /** Builds the public admin user profile including inherited permissions. */
  async getUserProfile(user: SeedUser): Promise<AdminUser> {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      enabled: user.enabled,
      roles: [...user.roles],
      permissions: collectPermissionsForUser(user, this.roles)
    };
  }

  /** Returns the RBAC-filtered menu tree visible to a user. */
  async getVisibleMenusForUser(user: SeedUser): Promise<MenuItem[]> {
    const permissions = collectPermissionsForUser(user, this.roles);
    return getVisibleMenus(this.menus, permissions);
  }

  /** Lists users with keyword filtering and pagination. */
  async listUsers(query: PaginationQuery): Promise<PaginatedResponse<AdminUser>> {
    /** Normalized keyword used across username, display name and email fields. */
    const keyword = query.keyword?.trim().toLowerCase();
    /** Filtered user list before pagination is applied. */
    const filtered = keyword
      ? this.users.filter((user) =>
          [user.username, user.displayName, user.email].some((value) => value.toLowerCase().includes(keyword))
        )
      : this.users;
    /** Zero-based slice offset for the requested page. */
    const start = (query.page - 1) * query.pageSize;
    /** Page items converted to public user profiles. */
    const items = await Promise.all(filtered.slice(start, start + query.pageSize).map((user) => this.getUserProfile(user)));

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total: filtered.length
    };
  }

  /** Creates a new user after checking username uniqueness and role validity. */
  async createUser(input: CreateUserRequest): Promise<AdminUser> {
    this.assertUniqueUsername(input.username);
    this.assertKnownRoles(input.roles);

    /** New mutable user record stored by the in-memory repository. */
    const user: SeedUser = {
      id: this.nextUserId(input.username),
      username: input.username,
      password: input.password,
      displayName: input.displayName,
      email: input.email,
      enabled: input.enabled,
      roles: [...input.roles],
      permissions: []
    };

    this.users.push(user);
    return this.getUserProfile(user);
  }

  /** Updates editable user profile fields and role assignments. */
  async updateUser(id: string, input: UpdateUserRequest): Promise<AdminUser | undefined> {
    /** User record selected by the stable route id. */
    const user = await this.findUserById(id);
    if (!user) return undefined;

    this.assertCanChangeEnabledState(user, input.enabled);
    this.assertKnownRoles(input.roles);

    user.displayName = input.displayName;
    user.email = input.email;
    user.enabled = input.enabled;
    user.roles = [...input.roles];

    return this.getUserProfile(user);
  }

  /** Deletes a non-built-in user and returns whether a row was removed. */
  async deleteUser(id: string): Promise<boolean> {
    /** Current user index in the mutable repository array. */
    const index = this.users.findIndex((user) => user.id === id);
    if (index === -1) return false;

    this.assertCanDeleteUser(this.users[index]!);
    this.users.splice(index, 1);
    return true;
  }

  /** Replaces a user's password without returning the secret value. */
  async resetUserPassword(id: string, password: string): Promise<boolean> {
    /** User record selected by the stable route id. */
    const user = await this.findUserById(id);
    if (!user) return false;

    user.password = password;
    return true;
  }

  /** Lists all role definitions. */
  async listRoles(): Promise<AdminRole[]> {
    return structuredClone(this.roles);
  }

  /** Lists the permission code universe available to role assignment forms. */
  async listPermissions(): Promise<PermissionCode[]> {
    return [...allPermissions];
  }

  /** Creates a role after checking code uniqueness and permission validity. */
  async createRole(input: CreateRoleRequest): Promise<AdminRole> {
    this.assertUniqueRoleCode(input.code);
    this.assertKnownPermissions(input.permissions);

    /** New role record stored by the in-memory repository. */
    const role: AdminRole = {
      id: this.nextRoleId(input.code),
      code: input.code,
      name: input.name,
      description: input.description,
      permissions: [...input.permissions]
    };

    this.roles.push(role);
    return structuredClone(role);
  }

  /** Updates a role's display metadata and permission assignments. */
  async updateRole(id: string, input: UpdateRoleRequest): Promise<AdminRole | undefined> {
    /** Existing role selected by stable route id. */
    const role = this.roles.find((item) => item.id === id);
    if (!role) return undefined;

    this.assertKnownPermissions(input.permissions);

    role.name = input.name;
    role.description = input.description;
    role.permissions = [...input.permissions];

    return structuredClone(role);
  }

  /** Deletes a non-built-in role that is not assigned to any user. */
  async deleteRole(id: string): Promise<boolean> {
    /** Existing role index in the mutable repository array. */
    const index = this.roles.findIndex((role) => role.id === id);
    if (index === -1) return false;

    this.assertCanDeleteRole(this.roles[index]!);
    this.roles.splice(index, 1);
    return true;
  }

  /** Lists the full menu tree for management screens without RBAC filtering. */
  async listManagedMenus(): Promise<MenuItem[]> {
    return structuredClone(this.menus);
  }

  /** Creates a menu tree node under the requested parent or at root level. */
  async createMenu(input: CreateMenuRequest): Promise<MenuItem> {
    this.assertKnownMenuPermission(input.permission);

    /** New menu tree node with generated id. */
    const menu: MenuItem = {
      id: this.nextMenuId(input.title),
      type: input.type,
      title: input.title,
      path: input.path,
      icon: input.icon,
      order: input.order,
      permission: input.permission
    };

    this.insertMenu(input.parentId ?? null, menu);
    return structuredClone(menu);
  }

  /** Updates an existing menu node and optionally moves it to another parent. */
  async updateMenu(id: string, input: UpdateMenuRequest): Promise<MenuItem | undefined> {
    this.assertKnownMenuPermission(input.permission);

    /** Existing menu node and parent collection selected by id. */
    const located = this.findMenuWithContainer(id);
    if (!located) return undefined;

    /** Updated menu node preserving its children. */
    const updated: MenuItem = {
      ...located.menu,
      type: input.type,
      title: input.title,
      path: input.path,
      icon: input.icon,
      order: input.order,
      permission: input.permission
    };

    located.container.splice(located.index, 1);
    this.insertMenu(input.parentId ?? null, updated);
    return structuredClone(updated);
  }

  /** Deletes a leaf menu node and rejects parent nodes with children. */
  async deleteMenu(id: string): Promise<boolean> {
    /** Existing menu node and parent collection selected by id. */
    const located = this.findMenuWithContainer(id);
    if (!located) return false;

    if (located.menu.children?.length) {
      throw new AdminRepositoryError('MENU_HAS_CHILDREN', 'Menu with children cannot be deleted');
    }

    located.container.splice(located.index, 1);
    return true;
  }

  /** Lists audit logs with keyword filtering and pagination. */
  async listAuditLogs(query: PaginationQuery): Promise<PaginatedResponse<AuditLog>> {
    /** Normalized keyword used across audit log searchable fields. */
    const keyword = query.keyword?.trim().toLowerCase();
    /** Filtered audit log list before pagination is applied. */
    const filtered = keyword
      ? this.auditLogs.filter((log) =>
          [log.actor, log.action, log.resource, log.detail ?? ''].some((value) => value.toLowerCase().includes(keyword))
        )
      : this.auditLogs;
    /** Zero-based slice offset for the requested audit log page. */
    const start = (query.page - 1) * query.pageSize;

    return {
      items: filtered.slice(start, start + query.pageSize),
      page: query.page,
      pageSize: query.pageSize,
      total: filtered.length
    };
  }

  /** Creates an audit log entry and prepends it to the in-memory list. */
  async createAuditLog(input: Omit<AuditLog, 'id' | 'createdAt'>): Promise<AuditLog> {
    /** New audit log record with generated id and timestamp. */
    const log: AuditLog = {
      ...input,
      id: `audit_${this.auditLogs.length + 1}`,
      createdAt: new Date().toISOString()
    };
    this.auditLogs.unshift(log);
    return log;
  }

  /** Creates a deterministic user id based on username with collision avoidance. */
  private nextUserId(username: string): string {
    /** Sanitized username segment safe for ids and snapshots. */
    const slug = username.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'user';
    /** Base id candidate used before appending a numeric suffix. */
    const baseId = `user_${slug}`;
    /** Existing user ids used for collision checks. */
    const ids = new Set(this.users.map((user) => user.id));

    if (!ids.has(baseId)) return baseId;

    /** Numeric suffix used when the base id already exists. */
    let suffix = 2;
    while (ids.has(`${baseId}_${suffix}`)) {
      suffix += 1;
    }
    return `${baseId}_${suffix}`;
  }

  /** Ensures a username can be used by a new user. */
  private assertUniqueUsername(username: string) {
    if (this.users.some((user) => user.username === username)) {
      throw new AdminRepositoryError('USERNAME_EXISTS', `Username already exists: ${username}`);
    }
  }

  /** Ensures every assigned role exists in the role catalog. */
  private assertKnownRoles(roleCodes: string[]) {
    /** Role code lookup used for O(1) assignment validation. */
    const knownRoleCodes = new Set(this.roles.map((role) => role.code));
    /** First submitted role code that is missing from the role catalog. */
    const missingRole = roleCodes.find((roleCode) => !knownRoleCodes.has(roleCode));

    if (missingRole) {
      throw new AdminRepositoryError('ROLE_NOT_FOUND', `Role does not exist: ${missingRole}`);
    }
  }

  /** Protects the built-in administrator from being disabled. */
  private assertCanChangeEnabledState(user: SeedUser, enabled: boolean) {
    if (user.username === 'admin' && !enabled) {
      throw new AdminRepositoryError('BUILT_IN_USER_PROTECTED', 'The built-in admin user cannot be disabled');
    }
  }

  /** Protects the built-in administrator from deletion. */
  private assertCanDeleteUser(user: SeedUser) {
    if (user.username === 'admin') {
      throw new AdminRepositoryError('BUILT_IN_USER_PROTECTED', 'The built-in admin user cannot be deleted');
    }
  }

  /** Creates a deterministic role id based on the submitted role code. */
  private nextRoleId(code: string): string {
    /** Sanitized role code segment safe for ids and snapshots. */
    const slug = code.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'role';
    /** Base id candidate used before appending a numeric suffix. */
    const baseId = `role_${slug}`;
    /** Existing role ids used for collision checks. */
    const ids = new Set(this.roles.map((role) => role.id));

    if (!ids.has(baseId)) return baseId;

    /** Numeric suffix used when the base id already exists. */
    let suffix = 2;
    while (ids.has(`${baseId}_${suffix}`)) {
      suffix += 1;
    }
    return `${baseId}_${suffix}`;
  }

  /** Ensures a role code can be used by a new role. */
  private assertUniqueRoleCode(code: string) {
    if (this.roles.some((role) => role.code === code)) {
      throw new AdminRepositoryError('ROLE_CODE_EXISTS', `Role code already exists: ${code}`);
    }
  }

  /** Ensures every assigned permission exists in the seed permission universe. */
  private assertKnownPermissions(permissions: PermissionCode[]) {
    /** Permission lookup used for assignment validation. */
    const knownPermissions = new Set(allPermissions);
    /** First submitted permission that is missing from the known universe. */
    const missingPermission = permissions.find((permission) => !knownPermissions.has(permission));

    if (missingPermission) {
      throw new AdminRepositoryError('PERMISSION_NOT_FOUND', `Permission does not exist: ${missingPermission}`);
    }
  }

  /** Protects built-in roles and assigned roles from deletion. */
  private assertCanDeleteRole(role: AdminRole) {
    /** Built-in role codes seeded for default demo accounts. */
    const builtInRoleCodes = new Set(['admin', 'manager', 'viewer']);

    if (builtInRoleCodes.has(role.code)) {
      throw new AdminRepositoryError('BUILT_IN_ROLE_PROTECTED', 'Built-in roles cannot be deleted');
    }

    if (this.users.some((user) => user.roles.includes(role.code))) {
      throw new AdminRepositoryError('ROLE_IN_USE', 'Assigned roles cannot be deleted');
    }
  }

  /** Creates a deterministic menu id based on title with collision avoidance. */
  private nextMenuId(title: string): string {
    /** Sanitized menu title segment safe for ids and snapshots. */
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'menu';
    /** Base id candidate used before appending a numeric suffix. */
    const baseId = `menu_${slug}`;
    /** Existing menu ids used for collision checks. */
    const ids = new Set(this.flattenMenus(this.menus).map((menu) => menu.id));

    if (!ids.has(baseId)) return baseId;

    /** Numeric suffix used when the base id already exists. */
    let suffix = 2;
    while (ids.has(`${baseId}_${suffix}`)) {
      suffix += 1;
    }
    return `${baseId}_${suffix}`;
  }

  /** Validates optional menu permission code against the known permission universe. */
  private assertKnownMenuPermission(permission: PermissionCode | undefined) {
    if (permission && !allPermissions.includes(permission)) {
      throw new AdminRepositoryError('PERMISSION_NOT_FOUND', `Permission does not exist: ${permission}`);
    }
  }

  /** Inserts a menu node into the requested parent collection while preserving order metadata. */
  private insertMenu(parentId: string | null, menu: MenuItem) {
    if (!parentId) {
      this.menus.push(menu);
      return;
    }

    /** Parent node selected for insertion. */
    const parent = this.findMenu(parentId, this.menus);
    if (!parent) {
      throw new AdminRepositoryError('MENU_PARENT_NOT_FOUND', `Menu parent does not exist: ${parentId}`);
    }

    parent.children = parent.children ?? [];
    parent.children.push(menu);
  }

  /** Recursively finds a menu by id. */
  private findMenu(id: string, menus: MenuItem[]): MenuItem | undefined {
    for (const menu of menus) {
      if (menu.id === id) return menu;
      /** Descendant menu node matching the requested id. */
      const child = menu.children ? this.findMenu(id, menu.children) : undefined;
      if (child) return child;
    }
    return undefined;
  }

  /** Recursively finds a menu plus the array that currently contains it. */
  private findMenuWithContainer(
    id: string,
    menus: MenuItem[] = this.menus
  ): { menu: MenuItem; container: MenuItem[]; index: number } | undefined {
    for (let index = 0; index < menus.length; index += 1) {
      /** Candidate menu node at the current collection index. */
      const menu = menus[index]!;
      if (menu.id === id) return { menu, container: menus, index };

      /** Descendant search result, if this menu has children. */
      const child = menu.children ? this.findMenuWithContainer(id, menu.children) : undefined;
      if (child) return child;
    }
    return undefined;
  }

  /** Flattens menu tree nodes for id lookup and collision checks. */
  private flattenMenus(menus: MenuItem[]): MenuItem[] {
    return menus.flatMap((menu) => [menu, ...(menu.children ? this.flattenMenus(menu.children) : [])]);
  }

  /** Serializes the in-memory records for localStorage persistence. */
  snapshot() {
    return {
      users: structuredClone(this.users),
      roles: structuredClone(this.roles),
      menus: structuredClone(this.menus),
      auditLogs: structuredClone(this.auditLogs),
    }
  }
}
