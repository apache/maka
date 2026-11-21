import type { PermissionConfig, PermissionNode } from '@/api/schemas';
import type { AppMenuItem } from '@/constants/menu';
import { BASIS_MENU } from '@/constants/menu';
import { API_WHITELIST } from '@/constants';
import { useGlobalStore } from '@/stores/global';

/**
 * 三级权限：页面（menu/subMenu）→ 接口（api）→ 按钮（btn）。
 * 沿用你在 SDCP/SSAP 时期的结构：后端下发权限树，前端拍平成 Map 查询。
 */

/** 权限树 → 扁平 map（menu/subMenu 以路由为 key，api/btn 以 target 为 key） */
export function generatePermissionMap(
  tree: PermissionNode[],
): Record<string, PermissionConfig> {
  const map: Record<string, PermissionConfig> = {};
  const walk = (nodes: PermissionNode[]) => {
    for (const node of nodes) {
      map[node.target] = { type: node.type, title: node.title };
      if (node.children) walk(node.children);
    }
  };
  walk(tree);
  return map;
}

/** 权限树 → 可渲染菜单（只取 menu/subMenu 节点，按 BASIS_MENU 的图标定义渲染） */
export function generateMenus(tree: PermissionNode[]): AppMenuItem[] {
  const iconByKey = new Map(BASIS_MENU.map((item) => [item.key, item.icon]));
  const menus: AppMenuItem[] = [];
  const walk = (nodes: PermissionNode[]) => {
    for (const node of nodes) {
      if (node.type === 'menu' || node.type === 'subMenu') {
        const icon = iconByKey.get(node.key);
        if (icon && node.target) {
          menus.push({ key: node.key, title: node.title ?? node.key, path: node.target, icon });
        }
      }
      if (node.children) walk(node.children);
    }
  };
  walk(tree);
  return menus;
}

/** 页面权限：精确匹配 → 动态路由正则匹配（:id 段编译为 \w+） */
export function checkPagePermission(pathname: string): boolean {
  if (['/', '/dashboard', '/users'].includes(pathname)) return true;

  const { permissionMap } = useGlobalStore.getState();
  // 模板模式：权限系统未接入（map 为空）时默认放行
  if (Object.keys(permissionMap).length === 0) return true;

  let permission = permissionMap[pathname];
  if (!permission) {
    for (const [key, value] of Object.entries(permissionMap)) {
      // 如果是动态路由（如 /users/:id）
      if (/^(\/\w+)*(\/:\w+)+$/.test(key)) {
        const pathnameReg = new RegExp(key.replaceAll(/:\w+/g, '\\w+'));
        if (pathnameReg.test(pathname)) {
          permission = value;
          break;
        }
      }
    }
  }
  return !!permission && ['menu', 'subMenu'].includes(permission.type);
}

/** 接口权限：白名单直通，其余查 map */
export function checkApiPermission(url: string): boolean {
  if (API_WHITELIST.includes(url)) return true;

  const { permissionMap } = useGlobalStore.getState();
  if (Object.keys(permissionMap).length === 0) return true;

  const permission = permissionMap[url];
  return !!permission && permission.type === 'api';
}

/** 按钮权限 */
export function checkBtnPermission(key: string): boolean {
  const { permissionMap } = useGlobalStore.getState();
  if (Object.keys(permissionMap).length === 0) return true;

  const permission = permissionMap[key];
  return !!permission && permission.type === 'btn';
}
