import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ProblemStatus } from '@/features/algo/types/problem';
import { nextStatus } from '@/features/algo/constants/problem-status';
import { createSafeJSONStorage } from './persist';

/** 做题进度 store:id → 状态(本地持久化)。 */
export interface ProgressState {
  /** 题目 id 到做题状态的映射。 */
  progress: Record<string, ProblemStatus>;
  /** 根据本次判题结果更新某题状态(遵循状态机:solved 为终态)。 */
  mark: (id: string, passed: boolean) => void;
}

/** 做题进度 store。 */
export const useProgressStore = create<ProgressState>()(
  persist(
    (set) => ({
      progress: {},
      mark: (id, passed) =>
        set((s) => ({
          progress: {
            ...s.progress,
            [id]: nextStatus(s.progress[id] ?? 'not-started', passed),
          },
        })),
    }),
    {
      name: 'algo:progress:v1',
      version: 1,
      partialize: (s) => ({ progress: s.progress }),
      storage: createSafeJSONStorage(),
    },
  ),
);
