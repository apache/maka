/**
 * 配置数据 Hook（基于 TanStack Query）
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "@/lib/cc/api";
import type { ReadResult } from "@/types/cc/settings";

const SETTINGS_KEY = ["settings"] as const;
const BACKUPS_KEY = ["backups"] as const;
const AUDIT_KEY = ["audit"] as const;

/**
 * 读取配置
 */
export function useSettings() {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => api.readSettings(),
    staleTime: 1000 * 30, // 30 秒内不重新请求
    refetchOnWindowFocus: true,
    retry: 1,
  });
}

/**
 * 切换插件开关
 */
export function useTogglePlugin() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      pluginId,
      enabled,
    }: {
      pluginId: string;
      enabled: boolean;
    }) => api.togglePlugin(pluginId, enabled),

    // 乐观更新
    onMutate: async ({ pluginId, enabled }) => {
      // 取消正在进行的请求
      await queryClient.cancelQueries({ queryKey: SETTINGS_KEY });

      // 保存旧数据用于回滚
      const previousData = queryClient.getQueryData<ReadResult>(SETTINGS_KEY);

      // 乐观更新
      if (previousData) {
        queryClient.setQueryData<ReadResult>(SETTINGS_KEY, {
          ...previousData,
          settings: {
            ...previousData.settings,
            enabledPlugins: {
              ...previousData.settings.enabledPlugins,
              [pluginId]: enabled,
            },
          },
        });
      }

      return { previousData };
    },

    // 错误时回滚
    onError: (_err, _variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(SETTINGS_KEY, context.previousData);
      }
    },

    // 成功后重新获取最新数据
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
      queryClient.invalidateQueries({ queryKey: AUDIT_KEY });
      queryClient.invalidateQueries({ queryKey: BACKUPS_KEY });
    },
  });
}

/**
 * 批量更新插件
 */
export function useBatchUpdatePlugins() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (updates: Record<string, boolean>) =>
      api.batchUpdatePlugins(updates),

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
      queryClient.invalidateQueries({ queryKey: AUDIT_KEY });
      queryClient.invalidateQueries({ queryKey: BACKUPS_KEY });
    },
  });
}

/**
 * 应用预设
 * 增强版：支持 optimistic update + 错误回滚
 */
export function useApplyPreset() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      presetPlugins,
      presetName,
    }: {
      presetPlugins: Record<string, boolean>;
      presetName: string;
    }) => api.applyPreset(presetPlugins, presetName),

    // 乐观更新：立即更新 UI，不等待写入完成
    onMutate: async ({ presetPlugins }) => {
      // 取消正在进行的请求
      await queryClient.cancelQueries({ queryKey: SETTINGS_KEY });

      // 保存旧数据用于回滚
      const previousData = queryClient.getQueryData<ReadResult>(SETTINGS_KEY);

      // 乐观更新：合并预设插件配置
      if (previousData) {
        queryClient.setQueryData<ReadResult>(SETTINGS_KEY, {
          ...previousData,
          settings: {
            ...previousData.settings,
            enabledPlugins: {
              ...previousData.settings.enabledPlugins,
              ...presetPlugins,
            },
          },
          // 临时更新 modifiedAt 以避免冲突误报
          modifiedAt: new Date().toISOString(),
        });
      }

      return { previousData };
    },

    // 错误时回滚到之前的数据
    onError: (_err, _variables, context) => {
      console.error("应用预设失败，正在回滚...");
      if (context?.previousData) {
        queryClient.setQueryData(SETTINGS_KEY, context.previousData);
      }
    },

    // 成功后：用返回的 hash 更新缓存，避免不必要的 refetch
    onSuccess: (newHash) => {
      const currentData = queryClient.getQueryData<ReadResult>(SETTINGS_KEY);
      if (currentData) {
        queryClient.setQueryData<ReadResult>(SETTINGS_KEY, {
          ...currentData,
          hash: newHash,
          modifiedAt: new Date().toISOString(),
        });
      }
    },

    // 完成后刷新审计和备份列表
    onSettled: () => {
      // 延迟刷新 settings，给文件 watcher 时间处理
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
      }, 500);
      queryClient.invalidateQueries({ queryKey: AUDIT_KEY });
      queryClient.invalidateQueries({ queryKey: BACKUPS_KEY });
    },
  });
}

/**
 * 获取备份列表
 */
export function useBackups() {
  return useQuery({
    queryKey: BACKUPS_KEY,
    queryFn: () => api.listBackups(),
    staleTime: 1000 * 60, // 1 分钟
  });
}

/**
 * 恢复备份
 */
export function useRestoreBackup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (backupPath: string) => api.restoreBackup(backupPath),

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
      queryClient.invalidateQueries({ queryKey: AUDIT_KEY });
      queryClient.invalidateQueries({ queryKey: BACKUPS_KEY });
    },
  });
}

/**
 * 获取审计日志
 */
export function useAuditLog(limit?: number) {
  return useQuery({
    queryKey: [...AUDIT_KEY, limit],
    queryFn: () => api.readAuditLog(limit),
    staleTime: 1000 * 30,
  });
}

/**
 * 手动刷新配置
 */
export function useRefreshSettings() {
  const queryClient = useQueryClient();

  return () => {
    queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
  };
}

// ============================================================
// P1-07: 自定义预设 CRUD
// ============================================================

const CUSTOM_PRESETS_KEY = ["customPresets"] as const;

/**
 * 获取自定义预设列表
 */
export function useCustomPresets() {
  return useQuery({
    queryKey: CUSTOM_PRESETS_KEY,
    queryFn: () => api.readCustomPresets(),
    staleTime: 1000 * 60 * 5, // 5 分钟
  });
}

/**
 * 保存自定义预设
 */
export function useSaveCustomPreset() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (preset: Parameters<typeof api.saveCustomPreset>[0]) =>
      api.saveCustomPreset(preset),

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: CUSTOM_PRESETS_KEY });
    },
  });
}

/**
 * 删除自定义预设
 */
export function useDeleteCustomPreset() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (presetId: string) => api.deleteCustomPreset(presetId),

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: CUSTOM_PRESETS_KEY });
    },
  });
}

/**
 * 导出预设
 */
export function useExportPresets() {
  return useMutation({
    mutationFn: (presetIds: string[]) => api.exportPresets(presetIds),
  });
}

/**
 * 导入预设
 */
export function useImportPresets() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (jsonData: string) => api.importPresets(jsonData),

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: CUSTOM_PRESETS_KEY });
    },
  });
}

// ============================================================
// P1-08: Profile 合并引擎
// ============================================================

const PROFILES_KEY = ["profiles"] as const;

/**
 * 获取 profile 列表
 */
export function useProfiles() {
  return useQuery({
    queryKey: PROFILES_KEY,
    queryFn: () => api.listProfiles(),
    staleTime: 1000 * 60, // 1 分钟
  });
}

/**
 * Profile 合并预览（dry-run）
 */
export function useMergeProfilePreview() {
  return useMutation({
    mutationFn: (profilePath: string) => api.mergeProfilePreview(profilePath),
  });
}

/**
 * 应用 Profile
 */
export function useApplyProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (profilePath: string) => api.applyProfile(profilePath),

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
      queryClient.invalidateQueries({ queryKey: AUDIT_KEY });
      queryClient.invalidateQueries({ queryKey: BACKUPS_KEY });
    },
  });
}
