import { z } from 'zod';
import { request } from '@/lib/api-client';
import {
  DashboardStatsSchema,
  PermissionNodeSchema,
  UserInfoSchema,
  UserPageSchema,
  type DashboardStats,
  type PermissionNode,
  type UserInfo,
  type UserPage,
} from '@/api/schemas';

/** 获取当前用户信息 */
export function getUserInfo() {
  return request<UserInfo>({
    url: '/admin/user-info',
    schema: UserInfoSchema,
  });
}

/** 获取权限树 */
export function getPermission(name: string) {
  return request<PermissionNode[]>({
    url: '/admin/permission',
    params: { name },
    schema: z.array(PermissionNodeSchema),
  });
}

/** 获取仪表盘统计数据 */
export function getDashboardStats() {
  return request<DashboardStats>({
    url: '/admin/dashboard-stats',
    schema: DashboardStatsSchema,
  });
}

interface UserPageParams {
  pageNum: number;
  pageSize: number;
  keyword?: string;
}

/** 分页查询用户列表 */
export function getUserPage(params: UserPageParams) {
  return request<UserPage>({
    url: '/admin/users',
    params,
    schema: UserPageSchema,
  });
}

/** 退出登录 */
export function logout() {
  return request<{ layoutUrl?: string }>({ url: '/admin/logout', method: 'POST' });
}
