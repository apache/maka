import { create } from 'zustand';
import type { PermissionConfig, UserInfo } from '@/api/schemas';
import { getUserInfo, getPermission, logout as logoutApi } from '@/api/admin';
import { generateMenus, generatePermissionMap } from '@/helpers/permission';
import { BASIS_MENU, type AppMenuItem } from '@/constants/menu';
import { clearToken } from '@/lib/api-client';

interface GlobalState {
  /** 系统初始化完成状态 */
  systemReady: boolean;
  userInfo: UserInfo | null;
  /** 扁平权限 map：menu/subMenu 以路由为 key，api/btn 以 target 为 key */
  permissionMap: Record<string, PermissionConfig>;
  /** 侧边栏菜单 */
  menus: AppMenuItem[];
  /** 应用启动引导：拉用户信息 + 权限树 */
  bootstrap: () => Promise<void>;
  logout: () => Promise<void>;
}

export const useGlobalStore = create<GlobalState>()((set, get) => ({
  systemReady: false,
  userInfo: null,
  permissionMap: {},
  menus: BASIS_MENU,

  bootstrap: async () => {
    if (get().systemReady) return;
    try {
      const userInfo = await getUserInfo();
      const permissionTree = await getPermission(userInfo.name);
      const permissionMap = generatePermissionMap(permissionTree);
      const menus = generateMenus(permissionTree);
      set({
        userInfo,
        permissionMap,
        menus: menus.length > 0 ? menus : BASIS_MENU,
        systemReady: true,
      });
    } catch {
      // 模板模式：后端未就绪时以基础菜单进入，接入真实接口后此分支仅兜底网络异常
      set({ menus: BASIS_MENU, systemReady: true });
    }
  },

  logout: async () => {
    try {
      await logoutApi();
    } finally {
      clearToken();
      set({ userInfo: null, permissionMap: {}, menus: BASIS_MENU, systemReady: false });
      window.location.href = '/';
    }
  },
}));
