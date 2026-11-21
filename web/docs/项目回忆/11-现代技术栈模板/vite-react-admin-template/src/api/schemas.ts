import { z } from 'zod';

/**
 * 接口契约层：所有响应结构先在这里声明，请求层做运行时校验。
 * 类型一律 z.infer 推导，不手写重复 interface。
 */

export const UserInfoSchema = z.object({
  employeeId: z.string(),
  name: z.string(),
  enName: z.string(),
  roleList: z.array(z.string()),
});
export type UserInfo = z.infer<typeof UserInfoSchema>;

export const PermissionTypeSchema = z.enum(['menu', 'subMenu', 'api', 'btn']);
export type PermissionType = z.infer<typeof PermissionTypeSchema>;

export interface PermissionNode {
  key: string;
  type: PermissionType;
  title?: string;
  /** menu/subMenu 节点的路由；api/btn 节点为接口路径或按钮标识 */
  target: string;
  children?: PermissionNode[];
}

/** 权限树（后端可能下发嵌套结构，用 z.lazy 递归校验） */
export const PermissionNodeSchema: z.ZodType<PermissionNode> = z.lazy(() =>
  z.object({
    key: z.string(),
    type: PermissionTypeSchema,
    title: z.string().optional(),
    target: z.string(),
    children: z.array(PermissionNodeSchema).optional(),
  }),
);

/** 扁平化后的权限项 */
export interface PermissionConfig {
  type: PermissionType;
  title?: string;
}

export const DashboardStatsSchema = z.object({
  totalUsers: z.number(),
  activeUsers: z.number(),
  todayOrders: z.number(),
  successRate: z.number(),
});
export type DashboardStats = z.infer<typeof DashboardStatsSchema>;

export const UserStatusSchema = z.enum(['active', 'disabled']);
export type UserStatus = z.infer<typeof UserStatusSchema>;

export const UserItemSchema = z.object({
  id: z.number(),
  userName: z.string(),
  email: z.string(),
  status: UserStatusSchema,
  createdAt: z.string(),
});
export type UserItem = z.infer<typeof UserItemSchema>;

export const UserPageSchema = z.object({
  list: z.array(UserItemSchema),
  meta: z.object({
    count: z.number(),
  }),
});
export type UserPage = z.infer<typeof UserPageSchema>;
