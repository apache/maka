/**
 * 官方插件目录（cc 域静态数据）。
 *
 * ⚠️ 原始文件因根 .gitignore 的 `data/` 规则误伤 src/data/ 从未入库，本机副本亦已丢失。
 * 当前文件为按全部调用点反推的最小类型骨架：目录数据为空，UI 将降级为「0 个官方插件」，
 * 各使用方均有 `entry?` 空值兜底，不会崩溃。真实插件目录需人工补录。
 */

export type PluginCategory = string;

export interface CatalogEntry {
  /** 短 ID（列表 key） */
  id: string;
  /** settings.json enabledPlugins 里的完整键名 */
  fullId: string;
  displayName: string;
  category: PluginCategory;
  publisher: string;
  /** 一句话简介（插件解决什么问题） */
  problem: string;
  useCases: string[];
  limitations: string[];
  /** 相关 settings.json 配置键 */
  configKeys: string[];
  securityNotes: string[];
  statusNotes?: string;
  homepage?: string;
}

export interface PluginUsageStats {
  referenceCount: number;
  files: string[];
  scannedAt: string;
}

/** 官方插件全量目录。数据丢失待补录，先保持空数组。 */
export const OFFICIAL_PLUGIN_CATALOG: CatalogEntry[] = [];

/** 「恢复默认」写入的初始开关状态。 */
export const DEFAULT_ENABLED_PLUGINS: Record<string, boolean> = {};

const CATEGORY_LABELS: Record<string, string> = {};

export function getCategoryLabel(category: PluginCategory): string {
  return CATEGORY_LABELS[category] ?? category;
}

/** 按分类分组的目录（配合 Object.entries 消费）。 */
export function groupPluginsByCategory(): Record<PluginCategory, CatalogEntry[]> {
  const groups: Record<PluginCategory, CatalogEntry[]> = {};
  for (const entry of OFFICIAL_PLUGIN_CATALOG) {
    (groups[entry.category] ??= []).push(entry);
  }
  return groups;
}

export function getCatalogEntry(pluginId: string): CatalogEntry | undefined {
  return OFFICIAL_PLUGIN_CATALOG.find((entry) => entry.fullId === pluginId || entry.id === pluginId);
}

/** 本项目对该插件的调用统计（pnpm scan:plugins 生成）。目录数据为空时无统计可查。 */
export function getPluginUsageStats(_pluginId: string): PluginUsageStats | null {
  return null;
}
