/**
 * 官方共用插件库面板
 * 展示系统支持的官方插件全量列表，支持一键恢复
 */

import { useState, useMemo } from "react";
import { ChevronDown, ChevronRight, RotateCcw, Info, AlertTriangle } from "lucide-react";
import {
  OFFICIAL_PLUGIN_CATALOG,
  DEFAULT_ENABLED_PLUGINS,
  getCategoryLabel,
  groupPluginsByCategory,
  type CatalogEntry,
  type PluginCategory,
} from '@/data/cc/pluginCatalog';
import { cn } from '@ggbdpq/console-ui';

interface PluginCatalogProps {
  /** 当前 settings.json 中的 enabledPlugins */
  currentPlugins: Record<string, boolean>;
  /** 恢复到默认集的回调 */
  onRestoreDefaults: (plugins: Record<string, boolean>) => void;
  /** 点击插件查看详情 */
  onPluginClick: (entry: CatalogEntry) => void;
  /** 是否正在恢复 */
  isRestoring?: boolean;
}

export function PluginCatalog({
  currentPlugins,
  onRestoreDefaults,
  onPluginClick,
  isRestoring = false,
}: PluginCatalogProps) {
  const [expandedCategories, setExpandedCategories] = useState<Set<PluginCategory>>(
    new Set(["output-style", "code-quality", "development"])
  );
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);

  const groupedPlugins = useMemo(() => groupPluginsByCategory(), []);

  // 计算恢复默认集的 diff
  const restoreDiff = useMemo(() => {
    const changes: Array<{ id: string; from: boolean | undefined; to: boolean }> = [];
    
    Object.entries(DEFAULT_ENABLED_PLUGINS).forEach(([id, defaultValue]) => {
      const currentValue = currentPlugins[id];
      if (currentValue !== defaultValue) {
        changes.push({
          id,
          from: currentValue,
          to: defaultValue,
        });
      }
    });

    return changes;
  }, [currentPlugins]);

  const toggleCategory = (category: PluginCategory) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  const handleRestoreClick = () => {
    if (restoreDiff.length === 0) {
      return; // 无需恢复
    }
    setShowRestoreConfirm(true);
  };

  const handleConfirmRestore = () => {
    onRestoreDefaults(DEFAULT_ENABLED_PLUGINS);
    setShowRestoreConfirm(false);
  };

  const getPluginStatus = (entry: CatalogEntry): "enabled" | "disabled" | "unknown" => {
    const value = currentPlugins[entry.fullId];
    if (value === undefined) {
      return "unknown";
    }
    return value ? "enabled" : "disabled";
  };

  return (
    <div className="h-full flex flex-col">
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            官方插件库
          </h2>
          <p className="text-xs text-muted-foreground">
            {OFFICIAL_PLUGIN_CATALOG.length} 个官方插件
          </p>
        </div>
        <button
          onClick={handleRestoreClick}
          disabled={isRestoring || restoreDiff.length === 0}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
            restoreDiff.length > 0
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "bg-card text-muted-foreground/75 cursor-not-allowed"
          )}
          title={restoreDiff.length === 0 ? "当前配置已是系统默认" : `${restoreDiff.length} 项将变更`}
        >
          <RotateCcw className={cn("size-3.5", isRestoring && "animate-spin")} />
          恢复默认
        </button>
      </div>

      {/* 恢复确认对话框 */}
      {showRestoreConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-popover rounded-xl shadow-2xl max-w-md w-full mx-4 overflow-hidden">
            <div className="px-6 py-4 border-b border-border">
              <h3 className="text-lg font-semibold text-foreground flex items-center gap-2">
                <AlertTriangle className="size-5 text-warning" />
                确认恢复默认配置
              </h3>
            </div>
            <div className="px-6 py-4">
              <p className="text-sm text-muted-foreground mb-4">
                以下 {restoreDiff.length} 个插件将被修改：
              </p>
              <div className="max-h-48 overflow-y-auto space-y-2">
                {restoreDiff.map((change) => (
                  <div
                    key={change.id}
                    className="flex items-center justify-between px-3 py-2 rounded-lg bg-card"
                  >
                    <span className="text-sm font-mono text-foreground truncate">
                      {change.id.split("@")[0]}
                    </span>
                    <div className="flex items-center gap-2 text-xs">
                      <span className={change.from ? "text-success" : "text-muted-foreground/75"}>
                        {change.from === undefined ? "未设置" : change.from ? "启用" : "禁用"}
                      </span>
                      <span className="text-muted-foreground/75">→</span>
                      <span className={change.to ? "text-success" : "text-muted-foreground/75"}>
                        {change.to ? "启用" : "禁用"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-4 text-xs text-muted-foreground">
                恢复前会自动创建备份，如有问题可在"审计日志"页回滚。
              </p>
            </div>
            <div className="px-6 py-4 border-t border-border flex justify-end gap-3">
              <button
                onClick={() => setShowRestoreConfirm(false)}
                className="px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:bg-card transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleConfirmRestore}
                disabled={isRestoring}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {isRestoring ? "恢复中..." : "确认恢复"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 插件列表 */}
      <div className="flex-1 overflow-y-auto">
        {(Object.entries(groupedPlugins) as [PluginCategory, CatalogEntry[]][]).map(
          ([category, plugins]) => {
            if (plugins.length === 0) return null;

            const isExpanded = expandedCategories.has(category);
            const enabledCount = plugins.filter(
              (p) => currentPlugins[p.fullId] === true
            ).length;

            return (
              <div key={category} className="border-b border-border last:border-b-0">
                {/* 分类标题 */}
                <button
                  onClick={() => toggleCategory(category)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-card transition-colors"
                >
                  <div className="flex items-center gap-2">
                    {isExpanded ? (
                      <ChevronDown className="size-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="size-4 text-muted-foreground" />
                    )}
                    <span className="text-sm font-medium text-foreground">
                      {getCategoryLabel(category)}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {enabledCount}/{plugins.length} 启用
                  </span>
                </button>

                {/* 插件列表 */}
                {isExpanded && (
                  <div className="pb-2">
                    {plugins.map((entry) => {
                      const status = getPluginStatus(entry);
                      return (
                        <button
                          key={entry.id}
                          onClick={() => onPluginClick(entry)}
                          className="w-full flex items-center justify-between px-4 py-2 hover:bg-card transition-colors group"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <div
                              className={cn(
                                "size-2 rounded-full flex-shrink-0",
                                status === "enabled" && "bg-success",
                                status === "disabled" && "bg-muted-foreground",
                                status === "unknown" && "bg-warning"
                              )}
                              title={
                                status === "enabled"
                                  ? "已启用"
                                  : status === "disabled"
                                  ? "已禁用"
                                  : "未配置"
                              }
                            />
                            <div className="min-w-0 text-left">
                              <p className="text-sm font-medium text-foreground truncate">
                                {entry.displayName}
                              </p>
                              <p className="text-xs text-muted-foreground truncate">
                                {entry.problem.slice(0, 30)}...
                              </p>
                            </div>
                          </div>
                          <Info className="size-4 text-muted-foreground/75 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }
        )}
      </div>

      {/* 底部统计 */}
      <div className="px-4 py-3 border-t border-border bg-card">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            已启用: {Object.values(currentPlugins).filter(Boolean).length} 个
          </span>
          <span>
            官方: {OFFICIAL_PLUGIN_CATALOG.length} 个
          </span>
        </div>
      </div>
    </div>
  );
}
