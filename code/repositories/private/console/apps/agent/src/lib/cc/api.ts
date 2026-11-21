/**
 * cc 域前端 API 层：HTTP fetch → /api/agentops/cc/*。
 * 原 Tauri invoke() 命令字符串分发层已退役——调用方直用具名函数，无第二通道。
 */

import type { ReadResult as RR, BackupInfo, AuditEntry } from "@/types/cc/settings";

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/agentops/cc${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new Error(body.message ?? `请求失败 ${res.status}`);
  return body as T;
}

// ---------- 桌面壳降栈后的形态标记（Web 化恒值，UI 分支保留） ----------

export function isTauriEnvironment(): boolean {
  return false; // Web 化后不再有 Tauri 通道
}

export type CustomPreset = {
  id: string;
  name: string;
  icon?: string;
  description?: string;
  enabledPlugins: Record<string, boolean>;
  createdAt?: string;
  updatedAt?: string;
};

export function isFileSystemAccessSupported(): boolean {
  return false; // 服务端常驻读写，不再需要 File System Access
}

export function isWebFileMode(): boolean {
  return false;
}

export async function openSettingsFile(): Promise<never> {
  throw new Error("服务端直连模式无需选择文件");
}

export async function reloadWebFile(): Promise<never> {
  throw new Error("服务端直连模式无需重载本地文件");
}

// ---------- profile 合并引擎类型（与 server 端对齐） ----------

export interface ProfileInfo {
  name: string;
  path: string;
  hasPatch: boolean;
  description?: string;
  modifiedAt?: string;
}

export interface MergePreview {
  merged: {
    enabledPlugins: Record<string, boolean>;
    env: Record<string, string>;
    language?: string;
    [key: string]: unknown;
  };
  addedKeys: string[];
  changedKeys: string[];
  removedKeys: string[];
}

// ---------- 命令式封装（useSettings 等 hook 的消费面，同桌面壳导出名） ----------

export async function readSettings(): Promise<RR> {
  return http<RR>("/settings");
}
export async function togglePlugin(pluginId: string, enabled: boolean): Promise<string> {
  const r = await http<{ hash: string }>("/settings/toggle-plugin", {
    method: "POST",
    body: JSON.stringify({ pluginId, enabled }),
  });
  return r.hash;
}
export async function batchUpdatePlugins(updates: Record<string, boolean>): Promise<string> {
  const r = await http<{ hash: string }>("/settings/batch-plugins", {
    method: "POST",
    body: JSON.stringify({ updates }),
  });
  return r.hash;
}
export async function applyPreset(
  presetPlugins: Record<string, boolean>,
  presetName: string,
): Promise<string> {
  const r = await http<{ hash: string }>("/settings/apply-preset", {
    method: "POST",
    body: JSON.stringify({ presetPlugins, presetName }),
  });
  return r.hash;
}
export async function listBackups(): Promise<BackupInfo[]> {
  const r = await http<{ backups: BackupInfo[] }>("/backups");
  return r.backups;
}
export async function restoreBackup(backupPath: string): Promise<string> {
  const r = await http<{ hash: string }>("/backups/restore", {
    method: "POST",
    body: JSON.stringify({ backupPath }),
  });
  return r.hash;
}
export async function readAuditLog(limit?: number): Promise<AuditEntry[]> {
  const r = await http<{ entries: AuditEntry[] }>(`/audit?limit=${limit ?? 20}`);
  return r.entries;
}
export async function readCustomPresets(): Promise<CustomPreset[]> {
  const r = await http<{ presets: CustomPreset[] }>("/presets");
  return r.presets;
}
export async function saveCustomPreset(preset: CustomPreset): Promise<CustomPreset> {
  const r = await http<{ preset: CustomPreset }>("/presets", {
    method: "POST",
    body: JSON.stringify(preset),
  });
  return r.preset;
}
export async function deleteCustomPreset(presetId: string): Promise<void> {
  await http<{ ok: boolean }>("/presets", {
    method: "DELETE",
    body: JSON.stringify({ presetId }),
  });
}
export async function exportPresets(presetIds: string[]): Promise<string> {
  const res = await fetch("/api/agentops/cc/presets/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ presetIds }),
  });
  return await res.text(); // 原命令返回 JSON 字符串
}
export async function importPresets(jsonData: string): Promise<CustomPreset[]> {
  const r = await http<{ presets: CustomPreset[] }>("/presets/import", {
    method: "POST",
    body: jsonData, // 原命令收 json_data 字符串；HTTP 端点直接收数组
  });
  return r.presets;
}
export async function listProfiles(): Promise<ProfileInfo[]> {
  const r = await http<{ profiles: ProfileInfo[] }>("/profiles");
  return r.profiles;
}
export async function mergeProfilePreview(profilePath: string): Promise<MergePreview> {
  const r = await http<{ preview: MergePreview }>("/profiles/preview", {
    method: "POST",
    body: JSON.stringify({ profileName: profilePath }),
  });
  return r.preview;
}
export async function applyProfile(profilePath: string): Promise<string> {
  const r = await http<{ hash: string }>("/profiles/apply", {
    method: "POST",
    body: JSON.stringify({ profileName: profilePath }),
  });
  return r.hash;
}
