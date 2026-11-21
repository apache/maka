import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSafeJSONStorage } from './persist';

/** 代码草稿:每题一份,持久化到 localStorage(刷新不丢代码)。 */
export interface DraftState {
  /** 题目 id → 用户草稿代码。 */
  drafts: Record<string, string>;
  /** 保存某题的草稿代码。 */
  setDraft: (id: string, code: string) => void;
}

/** 草稿 store。 */
export const useDraftStore = create<DraftState>()(
  persist(
    (set) => ({
      drafts: {},
      setDraft: (id, code) => set((s) => ({ drafts: { ...s.drafts, [id]: code } })),
    }),
    {
      name: 'algo:drafts:v1',
      version: 1,
      partialize: (s) => ({ drafts: s.drafts }),
      storage: createSafeJSONStorage(),
    },
  ),
);
