/**
 * CC 域 settings/presets/profiles 服务
 * 自 cc-profile src-tauri fs_service.rs（214 行命令层 + fs_service）忠实移植为 TS：
 * - 读改写三段式：before_hash → 备份 → 原子写 → 审计 → 写后回读
 * - 自定义预设 custom-presets.json、profile 目录扫描与合并
 * 路径注入：CONSOLE_CC_SETTINGS（目标 settings）、CC_PROFILE_HOME（数据根）、CC_DEV_ROOT（配置源根）
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { generate } from "./generate";
import { apply } from "./apply";

// ---------- 路径 ----------

export function getDataRoot(): string {
  const envRoot = process.env["CC_PROFILE_HOME"];
  if (envRoot) return envRoot;
  return path.join(os.homedir(), ".claude-profile");
}

export function getSettingsPath(): string {
  const envPath = process.env["CONSOLE_CC_SETTINGS"];
  if (envPath) return envPath;
  return path.join(os.homedir(), ".claude", "settings.json");
}

export function getDevRoot(): string {
  const envRoot = process.env["CC_DEV_ROOT"];
  if (envRoot) return envRoot;
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
}

export function computeHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").substring(0, 16);
}

// ---------- 类型（对齐 Rust config.rs，camelCase） ----------

export interface CcSettings {
  enabledPlugins: Record<string, boolean>;
  env?: Record<string, string>;
  language?: string;
  includeCoAuthoredBy?: boolean;
  [key: string]: unknown;
}

export interface ReadResult {
  settings: CcSettings;
  path: string;
  hash: string;
  modifiedAt: string;
}

export interface BackupInfo {
  path: string;
  createdAt: string;
  size: number;
  hash: string;
}

export type AuditAction =
  | "toggle_plugin"
  | "batch_update"
  | "apply_preset"
  | "restore_backup"
  | "write_settings"
  | "apply_profile";

export interface AuditEntry {
  timestamp: string;
  action: AuditAction;
  beforeHash: string;
  afterHash: string;
  changedKeys: string[];
  backupFile: string | null;
}

export interface CustomPreset {
  id: string;
  name: string;
  icon?: string;
  description?: string;
  enabledPlugins: Record<string, boolean>;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProfileInfo {
  name: string;
  path: string;
  hasPatch: boolean;
}

// ---------- settings 读写 ----------

export function readSettings(pathOverride?: string): ReadResult {
  const settingsPath = pathOverride ?? getSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    throw new Error(`配置文件不存在: ${settingsPath}`);
  }
  const content = fs.readFileSync(settingsPath, "utf-8");
  const settings = JSON.parse(content) as CcSettings;
  let modifiedAt = new Date().toISOString();
  try {
    modifiedAt = fs.statSync(settingsPath).mtime.toISOString();
  } catch {
    // mtime 读取失败回退 now
  }
  return { settings, path: settingsPath, hash: computeHash(content), modifiedAt };
}

function createBackup(settingsPath: string): BackupInfo {
  const content = fs.readFileSync(settingsPath, "utf-8");
  const hash = computeHash(content);
  const now = new Date();
  // 随机后缀与排他写入保护同一毫秒的备份，保留既有文件前缀。
  const pad = (n: number) => String(n).padStart(2, "0");
  const backupName = `settings.json.bak-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, "0")}-${crypto.randomUUID()}`;
  const backupDir = path.join(getDataRoot(), "backups");
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, backupName);
  fs.writeFileSync(backupPath, content, { encoding: "utf-8", flag: "wx" });
  return { path: backupPath, createdAt: now.toISOString(), size: Buffer.byteLength(content), hash };
}

function writeAuditEntry(entry: AuditEntry): void {
  const auditDir = path.join(getDataRoot(), "audit");
  if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
  fs.appendFileSync(path.join(auditDir, "audit.jsonl"), JSON.stringify(entry) + "\n", "utf-8");
}

function atomicWrite(settingsPath: string, content: string): void {
  const parent = path.dirname(settingsPath);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  const tempPath = path.join(parent, `.settings.json.tmp.${process.pid}`);
  fs.writeFileSync(tempPath, content, "utf-8");
  fs.renameSync(tempPath, settingsPath);
}

/**
 * 原子写入 + 备份 + 审计（对齐 Rust write_settings）。
 * 返回 afterHash；调用方需做写后回读校验。
 */
export function writeSettings(
  settings: CcSettings,
  action: AuditAction,
  changedKeys: string[],
): string {
  const settingsPath = getSettingsPath();
  const beforeHash = fs.existsSync(settingsPath)
    ? computeHash(fs.readFileSync(settingsPath, "utf-8"))
    : "empty";
  const backupFile = fs.existsSync(settingsPath) ? createBackup(settingsPath).path : null;

  const newContent = JSON.stringify(settings, null, 2);
  const afterHash = computeHash(newContent);
  atomicWrite(settingsPath, newContent);

  writeAuditEntry({
    timestamp: new Date().toISOString(),
    action,
    beforeHash,
    afterHash,
    changedKeys,
    backupFile,
  });
  return afterHash;
}

export function verifyWrite(expectedHash: string): boolean {
  const content = fs.readFileSync(getSettingsPath(), "utf-8");
  return computeHash(content) === expectedHash;
}

function readModifyWrite(
  action: AuditAction,
  changedKeys: string[],
  mutate: (settings: CcSettings) => void,
): string {
  const { settings } = readSettings();
  mutate(settings);
  const hash = writeSettings(settings, action, changedKeys);
  if (!verifyWrite(hash)) {
    throw new Error("写后回读验证失败，数据不一致");
  }
  return hash;
}

// ---------- 18 命令域 ----------

export function togglePlugin(pluginId: string, enabled: boolean): string {
  return readModifyWrite("toggle_plugin", [`enabledPlugins.${pluginId}`], (s) => {
    s.enabledPlugins = { ...(s.enabledPlugins ?? {}) };
    s.enabledPlugins[pluginId] = enabled;
  });
}

export function batchUpdatePlugins(updates: Record<string, boolean>): string {
  return readModifyWrite(
    "batch_update",
    Object.keys(updates).map((k) => `enabledPlugins.${k}`),
    (s) => {
      s.enabledPlugins = { ...(s.enabledPlugins ?? {}) };
      for (const [k, v] of Object.entries(updates)) s.enabledPlugins[k] = v;
    },
  );
}

export function applyPreset(presetPlugins: Record<string, boolean>, presetName: string): string {
  return readModifyWrite(
    "apply_preset",
    Object.keys(presetPlugins).map((k) => `enabledPlugins.${k}`),
    (s) => {
      s.enabledPlugins = { ...(s.enabledPlugins ?? {}) };
      for (const [k, v] of Object.entries(presetPlugins)) s.enabledPlugins[k] = v;
    },
  );
}

export function restoreBackup(backupPath: string): string {
  if (!fs.existsSync(backupPath)) throw new Error(`备份文件不存在: ${backupPath}`);
  const content = fs.readFileSync(backupPath, "utf-8");
  const settings = JSON.parse(content) as CcSettings; // 验证 JSON 合法
  return readModifyWrite("restore_backup", ["*"], (s) => {
    Object.assign(s, settings);
  });
}

export function checkSettingsExists(): boolean {
  return fs.existsSync(getSettingsPath());
}

export function getCurrentHash(): string {
  return readSettings().hash;
}

// ---------- 自定义预设（custom-presets.json） ----------

function customPresetsPath(): string {
  const root = getDataRoot();
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return path.join(root, "custom-presets.json");
}

export function readCustomPresets(): CustomPreset[] {
  const p = customPresetsPath();
  if (!fs.existsSync(p)) return [];
  const store = JSON.parse(fs.readFileSync(p, "utf-8")) as { presets: CustomPreset[] };
  return store.presets ?? [];
}

export function saveCustomPreset(preset: CustomPreset): CustomPreset {
  const presets = readCustomPresets();
  const now = new Date().toISOString();
  const idx = presets.findIndex((x) => x.id === preset.id);
  if (idx >= 0) {
    const updated: CustomPreset = { ...preset, createdAt: presets[idx]!.createdAt, updatedAt: now };
    presets[idx] = updated;
    fs.writeFileSync(customPresetsPath(), JSON.stringify({ presets }, null, 2), "utf-8");
    return updated;
  }
  const created: CustomPreset = { ...preset, createdAt: now, updatedAt: now };
  presets.push(created);
  fs.writeFileSync(customPresetsPath(), JSON.stringify({ presets }, null, 2), "utf-8");
  return created;
}

export function deleteCustomPreset(presetId: string): void {
  const presets = readCustomPresets().filter((x) => x.id !== presetId);
  fs.writeFileSync(customPresetsPath(), JSON.stringify({ presets }, null, 2), "utf-8");
}

export function exportPresets(presetIds: string[]): string {
  return JSON.stringify(readCustomPresets().filter((x) => presetIds.includes(x.id)), null, 2);
}

export function importPresets(jsonData: string): CustomPreset[] {
  const incoming = JSON.parse(jsonData) as CustomPreset[];
  const existing = readCustomPresets();
  const now = new Date().toISOString();
  const merged: CustomPreset[] = [...existing];
  for (const p of incoming) {
    const idx = merged.findIndex((x) => x.id === p.id);
    const item: CustomPreset = { ...p, updatedAt: now, createdAt: p.createdAt ?? now };
    if (idx >= 0) merged[idx] = item;
    else merged.push(item);
  }
  fs.writeFileSync(customPresetsPath(), JSON.stringify({ presets: merged }, null, 2), "utf-8");
  return merged;
}

// ---------- Profile 合并引擎 ----------

export function listProfiles(): ProfileInfo[] {
  const profilesDir = path.join(getDevRoot(), ".claude", "profiles");
  if (!fs.existsSync(profilesDir)) return [];
  return fs
    .readdirSync(profilesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({
      name: e.name,
      path: path.join(profilesDir, e.name),
      hasPatch: fs.existsSync(path.join(profilesDir, e.name, "settings.patch.json")),
    }));
}

export async function mergeProfilePreview(profileName: string) {
  const r = await generate(profileName, { dryRun: true });
  if (!r.success) throw new Error(r.error ?? "合并预览失败");
  return r.data; // { merged, stats }——dryRun 不落盘
}

export async function applyProfile(profileName: string) {
  const gen = await generate(profileName, { dryRun: false });
  if (!gen.success) throw new Error(gen.error ?? "生成失败");
  const r = await apply({ profile: profileName });
  if (!r.success) throw new Error(r.error ?? "应用失败");
  return getCurrentHash();
}
