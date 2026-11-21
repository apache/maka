import type { LucideIcon } from 'lucide-react';
import { LayoutDashboard, Users } from 'lucide-react';

export interface AppMenuItem {
  /** 菜单唯一标识，同时用于权限匹配 */
  key: string;
  title: string;
  path: string;
  icon: LucideIcon;
}

/** 基础菜单（对标原模板 BASIS_MENU）：权限系统未接入时的兜底菜单 */
export const BASIS_MENU: AppMenuItem[] = [
  { key: 'dashboard', title: '仪表盘', path: '/dashboard', icon: LayoutDashboard },
  { key: 'users', title: '用户管理', path: '/users', icon: Users },
];
