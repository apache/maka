import { create } from 'zustand';
import { getUserPage } from '@/api/admin';
import type { UserItem } from '@/api/schemas';

interface UserPageParams {
  pageNum: number;
  pageSize: number;
  keyword: string;
}

interface UsersState {
  params: UserPageParams;
  list: UserItem[];
  total: number;
  loading: boolean;
  /** 搜索/重置的自增令牌：触发 effect 重新拉取，避免手动请求与 effect 并发 */
  submitToken: number;
  setKeyword: (keyword: string) => void;
  setPageNum: (pageNum: number) => void;
  resetParams: () => void;
  submit: () => void;
  fetchUsers: () => Promise<void>;
}

const DEFAULT_PARAMS: UserPageParams = { pageNum: 1, pageSize: 10, keyword: '' };

/** 页面级 store（对标原模板 index.hook.tsx + store.ts 的分工：视图外移逻辑） */
export const useUsersStore = create<UsersState>()((set, get) => ({
  params: { ...DEFAULT_PARAMS },
  list: [],
  total: 0,
  loading: false,
  submitToken: 0,

  setKeyword: (keyword) => set({ params: { ...get().params, keyword } }),
  setPageNum: (pageNum) => set({ params: { ...get().params, pageNum } }),
  resetParams: () => set({ params: { ...DEFAULT_PARAMS } }),
  // zustand set 同步生效，effect 里 fetchUsers 总能读到最新 params
  submit: () => set({ submitToken: get().submitToken + 1 }),

  fetchUsers: async () => {
    const { params } = get();
    set({ loading: true });
    try {
      const page = await getUserPage(params);
      set({ list: page.list, total: page.meta.count });
    } finally {
      set({ loading: false });
    }
  },
}));
