/**
 * 插件状态管理（Zustand）
 */

import { create } from "zustand";

interface PluginState {
  // 展开的分组
  expandedGroups: Set<string>;
  // 待处理的插件切换（用于乐观更新）
  pendingPlugins: Map<string, boolean>;
  // 最后已知的配置哈希（用于检测外部修改）
  lastKnownHash: string | null;
  // 是否有未保存的冲突
  hasConflict: boolean;

  // Actions
  toggleGroupExpanded: (groupId: string) => void;
  setGroupExpanded: (groupId: string, expanded: boolean) => void;
  setPendingPlugin: (pluginId: string, enabled: boolean) => void;
  clearPendingPlugin: (pluginId: string) => void;
  clearAllPending: () => void;
  setLastKnownHash: (hash: string) => void;
  setConflict: (hasConflict: boolean) => void;
}

export const usePluginStore = create<PluginState>((set) => ({
  expandedGroups: new Set(["official", "third-party"]),
  pendingPlugins: new Map(),
  lastKnownHash: null,
  hasConflict: false,

  toggleGroupExpanded: (groupId) =>
    set((state) => {
      const newSet = new Set(state.expandedGroups);
      if (newSet.has(groupId)) {
        newSet.delete(groupId);
      } else {
        newSet.add(groupId);
      }
      return { expandedGroups: newSet };
    }),

  setGroupExpanded: (groupId, expanded) =>
    set((state) => {
      const newSet = new Set(state.expandedGroups);
      if (expanded) {
        newSet.add(groupId);
      } else {
        newSet.delete(groupId);
      }
      return { expandedGroups: newSet };
    }),

  setPendingPlugin: (pluginId, enabled) =>
    set((state) => {
      const newMap = new Map(state.pendingPlugins);
      newMap.set(pluginId, enabled);
      return { pendingPlugins: newMap };
    }),

  clearPendingPlugin: (pluginId) =>
    set((state) => {
      const newMap = new Map(state.pendingPlugins);
      newMap.delete(pluginId);
      return { pendingPlugins: newMap };
    }),

  clearAllPending: () => set({ pendingPlugins: new Map() }),

  setLastKnownHash: (hash) => set({ lastKnownHash: hash }),

  setConflict: (hasConflict) => set({ hasConflict }),
}));
