/**
 * settings.json 类型定义
 */

import { z } from "zod";

/**
 * 配置结构 Schema
 */
export const settingsSchema = z.object({
  enabledPlugins: z.record(z.string(), z.boolean()).default({}),
  env: z.record(z.string(), z.string()).default({}),
  language: z.string().optional(),
  includeCoAuthoredBy: z.boolean().optional(),
});

export type Settings = z.infer<typeof settingsSchema>;

/**
 * 读取结果（包含元数据）
 */
export interface ReadResult {
  settings: Settings;
  path: string;
  hash: string;
  modifiedAt: string;
}

/**
 * 备份信息
 */
export interface BackupInfo {
  path: string;
  createdAt: string;
  size: number;
  hash: string;
}

/**
 * 审计操作类型
 */
export type AuditAction =
  | "toggle_plugin"
  | "apply_preset"
  | "batch_update"
  | "restore_backup"
  | "manual_write";

/**
 * 审计日志条目
 */
export interface AuditEntry {
  timestamp: string;
  action: AuditAction;
  beforeHash: string;
  afterHash: string;
  changedKeys: string[];
  backupFile: string | null;
}

/**
 * 插件信息
 */
export interface PluginInfo {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  source: "official" | "third-party" | "unknown";
}

/**
 * 判断是否是敏感字段（用于脱敏）
 */
export function isSensitiveKey(key: string): boolean {
  const sensitivePatterns = [
    "TOKEN",
    "KEY",
    "SECRET",
    "PASSWORD",
    "CREDENTIAL",
    "AUTH",
  ];
  const upperKey = key.toUpperCase();
  return sensitivePatterns.some((pattern) => upperKey.includes(pattern));
}

/**
 * 脱敏显示敏感值
 */
export function maskSensitiveValue(value: string): string {
  if (value.length <= 8) {
    return "****";
  }
  return value.slice(0, 4) + "****" + value.slice(-4);
}

/**
 * 从插件 ID 提取信息
 */
export function parsePluginId(
  pluginId: string
): { name: string; source: string } {
  const parts = pluginId.split("@");
  if (parts.length === 2) {
    return {
      name: parts[0],
      source: parts[1],
    };
  }
  return {
    name: pluginId,
    source: "unknown",
  };
}

/**
 * 获取插件来源类型
 */
export function getPluginSource(
  pluginId: string
): "official" | "third-party" | "unknown" {
  const { source } = parsePluginId(pluginId);
  if (source === "claude-plugins-official") {
    return "official";
  }
  if (source === "unknown") {
    return "unknown";
  }
  return "third-party";
}
