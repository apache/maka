/**
 * 预设状态管理（Zustand）
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Preset } from "@/lib/cc/presets";
import { BUILTIN_PRESETS } from "@/lib/cc/presets";

interface PresetState {
  // 当前选中的预设 ID
  activePresetId: string | null;
  // 自定义预设列表
  customPresets: Preset[];

  // Actions
  setActivePreset: (id: string | null) => void;
  addCustomPreset: (preset: Preset) => void;
  updateCustomPreset: (id: string, updates: Partial<Preset>) => void;
  deleteCustomPreset: (id: string) => void;
  getAllPresets: () => Preset[];
}

// localStorage key 常量
const STORAGE_KEY = "claude-profile-presets";

export const usePresetStore = create<PresetState>()(
  persist(
    (set, get) => ({
      activePresetId: null,
      customPresets: [],

      setActivePreset: (id) => set({ activePresetId: id }),

      addCustomPreset: (preset) =>
        set((state) => ({
          customPresets: [...state.customPresets, { ...preset, builtin: false }],
        })),

      updateCustomPreset: (id, updates) =>
        set((state) => ({
          customPresets: state.customPresets.map((p) =>
            p.id === id ? { ...p, ...updates } : p
          ),
        })),

      deleteCustomPreset: (id) =>
        set((state) => ({
          customPresets: state.customPresets.filter((p) => p.id !== id),
          // 如果删除的是当前活动预设，清除选中状态
          activePresetId:
            state.activePresetId === id ? null : state.activePresetId,
        })),

      getAllPresets: () => {
        const { customPresets } = get();
        return [...BUILTIN_PRESETS, ...customPresets];
      },
    }),
    {
      name: STORAGE_KEY,
      // 只持久化自定义预设
      partialize: (state) => ({
        customPresets: state.customPresets,
      }),
    }
  )
);
