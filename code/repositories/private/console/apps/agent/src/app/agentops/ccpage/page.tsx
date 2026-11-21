'use client'

/**
 * CC Profile 主应用
 */

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { QueryClient, QueryClientProvider, useIsMutating } from "@tanstack/react-query";
import {
  RefreshCw,
  AlertTriangle,
  Settings,
  History,
  FileJson,
  FolderOpen,
} from "lucide-react";

import { PresetSidebar } from "@/components/cc/PresetSidebar";
import { PresetDiffDialog } from "@/components/cc/PresetDiffDialog";
import { PresetEditor } from "@/components/cc/PresetEditor";
import { PluginGroup } from "@/components/cc/PluginGroup";
import { PluginSwitch } from "@/components/cc/PluginSwitch";
import { EnvDisplay } from "@/components/cc/EnvDisplay";
import { AuditLog } from "@/components/cc/AuditLog";
import { ConflictDialog } from "@/components/cc/ConflictDialog";
import { ProfileMerge } from "@/components/cc/ProfileMerge";
import { HistoryTimeline } from "@/components/cc/HistoryTimeline";
import { PluginCatalog } from "@/components/cc/PluginCatalog";
import { PluginDetailPage } from "@/components/cc/PluginDetailPage";
import type { CatalogEntry } from "@/data/cc/pluginCatalog";
import {
  useSettings,
  useTogglePlugin,
  useApplyPreset,
  useRefreshSettings,
  useSaveCustomPreset,
  useDeleteCustomPreset,
} from "@/hooks/cc/useSettings";
import { useFileWatcher } from "@/hooks/cc/useFileWatcher";
import { useKeyboardShortcuts } from "@/hooks/cc/useKeyboardShortcuts";
import { usePluginStore } from "@/stores/cc/pluginStore";
import { ThemeToggle, useTheme } from "@ggbdpq/console-ui";
import { getPluginSource } from "@/types/cc/settings";
import type { Preset } from "@/lib/cc/presets";
import type { CustomPreset } from "@/lib/cc/api";
import { cn } from "@ggbdpq/console-ui";
import * as api from "@/lib/cc/api";

// 创建 QueryClient
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 1000 * 30,
    },
  },
});

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <MainLayout />
    </QueryClientProvider>
  );
}

type TabType = "plugins" | "env" | "profiles" | "audit";

interface ConflictState {
  isOpen: boolean;
  newHash: string;
  changeTime: string;
}

interface PresetPreviewState {
  isOpen: boolean;
  preset: Preset | CustomPreset | null;
}

interface PresetEditorState {
  isOpen: boolean;
  mode: "create" | "edit" | "duplicate";
  preset: CustomPreset | null;
}

// 视图状态：列表或详情页
type ViewState = 
  | { type: "list" }
  | { type: "detail"; pluginId: string };

function MainLayout() {
  const [activeTab, setActiveTab] = useState<TabType>("plugins");
  const [conflict, setConflict] = useState<ConflictState>({
    isOpen: false,
    newHash: "",
    changeTime: "",
  });
  const [presetPreview, setPresetPreview] = useState<PresetPreviewState>({
    isOpen: false,
    preset: null,
  });
  const [presetError, setPresetError] = useState<string | null>(null);
  // P1-07: 预设编辑器状态
  const [presetEditor, setPresetEditor] = useState<PresetEditorState>({
    isOpen: false,
    mode: "create",
    preset: null,
  });
  
  // Web 模式状态
  const [isWebMode] = useState(() => !api.isTauriEnvironment());
  const [webFileError, setWebFileError] = useState<string | null>(null);
  const [isSelectingFile, setIsSelectingFile] = useState(false);
  
  // 视图状态（列表 vs 详情页）
  const [currentView, setCurrentView] = useState<ViewState>({ type: "list" });
  const [isRestoringDefaults, setIsRestoringDefaults] = useState(false);

  const { data, isLoading, error, refetch } = useSettings();
  
  // Web 模式：打开文件选择器
  const handleOpenFile = useCallback(async () => {
    if (!api.isFileSystemAccessSupported()) {
      setWebFileError("您的浏览器不支持 File System Access API，请使用 Chrome 86+ 或 Edge 86+");
      return;
    }
    
    setIsSelectingFile(true);
    setWebFileError(null);
    
    try {
      await api.openSettingsFile();
      // 重新获取数据
      refetch();
    } catch (err) {
      if ((err as Error).message !== "用户取消了文件选择") {
        setWebFileError((err as Error).message);
      }
    } finally {
      setIsSelectingFile(false);
    }
  }, [refetch]);
  
  // Web 模式：重新加载文件
  const handleReloadWebFile = useCallback(async () => {
    try {
      await api.reloadWebFile();
      refetch();
    } catch (err) {
      setWebFileError((err as Error).message);
    }
  }, [refetch]);
  const togglePlugin = useTogglePlugin();
  const applyPreset = useApplyPreset();
  const refreshSettings = useRefreshSettings();
  // P1-07: 自定义预设 hooks
  const saveCustomPreset = useSaveCustomPreset();
  const deleteCustomPreset = useDeleteCustomPreset();
  // P2-10: 主题切换（统一走 @ggbdpq/console-ui 的 theme module）
  const { cycle } = useTheme();

  // P2-10: 键盘快捷键
  useKeyboardShortcuts({
    onRefresh: () => refetch(),
    onToggleTheme: () => {
      cycle();
    },
    onSwitchTab: (tab) => setActiveTab(tab as TabType),
  });
  const {
    expandedGroups,
    toggleGroupExpanded,
    lastKnownHash,
    setLastKnownHash,
    hasConflict,
    setConflict: setStoreConflict,
  } = usePluginStore();

  // 处理文件变更冲突
  const handleConflict = useCallback(
    (event: { newHash: string; changeType: string; timestamp: string }) => {
      setConflict({
        isOpen: true,
        newHash: event.newHash,
        changeTime: event.timestamp,
      });
    },
    []
  );

  // 检测是否有正在进行的 mutation
  const isMutating = useIsMutating();
  
  // 用于记录最近一次写入时间，避免自身写入触发冲突
  const lastWriteTimeRef = useRef<number>(0);

  // 启用文件监听
  const { markWritePending } = useFileWatcher(handleConflict);

  // 检测外部修改（轮询备用方案）
  // 修改：如果有正在进行的 mutation，不触发冲突检测
  useEffect(() => {
    if (data?.hash) {
      const now = Date.now();
      const isRecentWrite = now - lastWriteTimeRef.current < 3000; // 3秒内的写入不算外部修改
      
      if (lastKnownHash && lastKnownHash !== data.hash) {
        // 如果正在写入或刚刚写入完成，不弹冲突对话框
        if (isMutating > 0 || isRecentWrite) {
          console.log("检测到 hash 变化，但正在写入中，跳过冲突检测");
        } else {
          // 真正的外部修改
          console.log("配置文件被外部修改，已自动刷新");
          if (!conflict.isOpen) {
            setConflict({
              isOpen: true,
              newHash: data.hash,
              changeTime: data.modifiedAt,
            });
          }
        }
      }
      setLastKnownHash(data.hash);
    }
  }, [data?.hash, data?.modifiedAt, lastKnownHash, setLastKnownHash, conflict.isOpen, isMutating]);

  // 定期检查外部修改（备用轮询）
  useEffect(() => {
    const interval = setInterval(() => {
      refetch();
    }, 5000); // 每 5 秒检查一次

    return () => clearInterval(interval);
  }, [refetch]);

  // 处理冲突对话框操作
  const handleCloseConflict = () => {
    setConflict({ ...conflict, isOpen: false });
    setStoreConflict(false);
  };

  const handleReloadFromDisk = () => {
    refetch();
    handleCloseConflict();
  };

  const handleKeepLocal = () => {
    // 保持本地状态，忽略外部修改
    // 下次用户操作时会覆盖外部修改
    handleCloseConflict();
  };

  // 按来源分组插件
  const pluginGroups = useMemo(() => {
    if (!data?.settings.enabledPlugins) return {};

    const groups: Record<string, Array<{ id: string; enabled: boolean }>> = {
      official: [],
      "third-party": [],
      unknown: [],
    };

    Object.entries(data.settings.enabledPlugins).forEach(([id, enabled]) => {
      const source = getPluginSource(id);
      groups[source].push({ id, enabled: Boolean(enabled) });
    });

    // 按名称排序
    Object.values(groups).forEach((group) =>
      group.sort((a, b) => a.id.localeCompare(b.id))
    );

    return groups;
  }, [data?.settings.enabledPlugins]);

  const handleTogglePlugin = async (pluginId: string, enabled: boolean) => {
    try {
      await togglePlugin.mutateAsync({ pluginId, enabled });
    } catch (error) {
      console.error("切换插件失败:", error);
    }
  };

  // N1: 恢复系统默认集
  const handleRestoreDefaults = async (defaultPlugins: Record<string, boolean>) => {
    setIsRestoringDefaults(true);
    try {
      markWritePending();
      lastWriteTimeRef.current = Date.now();
      
      await applyPreset.mutateAsync({
        presetPlugins: defaultPlugins,
        presetName: "系统默认配置",
      });
    } catch (error) {
      console.error("恢复默认配置失败:", error);
    } finally {
      setIsRestoringDefaults(false);
    }
  };

  // 导航到插件详情页
  const navigateToPluginDetail = useCallback((pluginId: string) => {
    setCurrentView({ type: "detail", pluginId });
  }, []);

  // 从详情页返回列表
  const navigateToPluginList = useCallback(() => {
    setCurrentView({ type: "list" });
  }, []);

  // N2: 打开插件详情（从 PluginCatalog 点击）
  const handlePluginClick = (entry: CatalogEntry) => {
    navigateToPluginDetail(entry.fullId);
  };

  // N2: 在详情页切换插件状态
  const handlePluginToggleFromDetail = async (enabled: boolean) => {
    if (currentView.type !== "detail") return;
    
    try {
      await togglePlugin.mutateAsync({
        pluginId: currentView.pluginId,
        enabled,
      });
    } catch (error) {
      console.error("切换插件失败:", error);
    }
  };

  // P1-06: 点击预设时先打开 diff 预览对话框
  const handlePresetClick = (preset: Preset | CustomPreset) => {
    setPresetError(null);
    setPresetPreview({ isOpen: true, preset });
  };

  // P1-06: 确认应用预设
  const handleConfirmApplyPreset = async () => {
    if (!presetPreview.preset) return;

    // 获取预设的插件配置
    const plugins = presetPreview.preset.enabledPlugins;

    try {
      // 标记即将写入，避免文件 watcher 误报冲突
      markWritePending();
      lastWriteTimeRef.current = Date.now();
      
      await applyPreset.mutateAsync({
        presetPlugins: plugins,
        presetName: presetPreview.preset.name,
      });
      // 成功后关闭对话框
      setPresetPreview({ isOpen: false, preset: null });
    } catch (error) {
      // 失败时显示错误，对话框保持打开
      setPresetError(String(error));
      console.error("应用预设失败:", error);
      throw error; // 重新抛出让 dialog 处理
    }
  };

  // P1-06: 关闭预设预览对话框
  const handleClosePresetPreview = () => {
    setPresetPreview({ isOpen: false, preset: null });
    setPresetError(null);
  };

  // P1-07: 打开预设编辑器
  const handleCreatePreset = () => {
    setPresetEditor({ isOpen: true, mode: "create", preset: null });
  };

  const handleEditPreset = (preset: CustomPreset, mode: "edit" | "duplicate") => {
    setPresetEditor({ isOpen: true, mode, preset });
  };

  const handleClosePresetEditor = () => {
    setPresetEditor({ isOpen: false, mode: "create", preset: null });
  };

  const handleSavePreset = async (
    preset: Omit<CustomPreset, "createdAt" | "updatedAt">
  ) => {
    await saveCustomPreset.mutateAsync({
      ...preset,
      createdAt: "",
      updatedAt: "",
    });
  };

  const handleDeletePreset = async (presetId: string) => {
    await deleteCustomPreset.mutateAsync(presetId);
  };

  // 加载中状态：骨架屏与最终双栏布局同形（Vercel 指南：内容区禁大转圈）
  if (isLoading) {
    return (
      <div className="flex h-full gap-4 bg-background p-4">
        <div className="w-60 shrink-0 animate-pulse rounded-lg bg-muted" />
        <div className="flex flex-1 flex-col gap-4">
          <div className="h-14 animate-pulse rounded-lg bg-muted" />
          <div className="flex-1 animate-pulse rounded-lg bg-muted" />
        </div>
      </div>
    );
  }

  // 错误状态
  if (error) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="text-center max-w-md p-6">
          <AlertTriangle className="size-12 mx-auto mb-4 text-destructive" />
          <h2 className="text-lg font-semibold text-foreground mb-2">
            读取配置失败
          </h2>
          <p className="text-muted-foreground mb-4">
            {String(error)}
          </p>
          <button
            onClick={() => refetch()}
            className="btn-primary flex items-center gap-2 mx-auto"
          >
            <RefreshCw className="size-4" />
            重试
          </button>
        </div>
      </div>
    );
  }

  const groupLabels: Record<string, string> = {
    official: "官方插件",
    "third-party": "第三方插件",
    unknown: "其他插件",
  };

  return (
    <div className="h-full flex bg-background">
      {/* 冲突对话框 */}
      <ConflictDialog
        isOpen={conflict.isOpen}
        onClose={handleCloseConflict}
        onReload={handleReloadFromDisk}
        onKeepLocal={handleKeepLocal}
        newHash={conflict.newHash}
        changeTime={conflict.changeTime}
      />

      {/* P1-06: 预设差异预览对话框 */}
      <PresetDiffDialog
        isOpen={presetPreview.isOpen}
        preset={presetPreview.preset}
        currentPlugins={data?.settings.enabledPlugins || {}}
        onClose={handleClosePresetPreview}
        onApply={handleConfirmApplyPreset}
        isApplying={applyPreset.isPending}
        error={presetError}
      />

      {/* P1-07: 预设编辑器 */}
      <PresetEditor
        isOpen={presetEditor.isOpen}
        mode={presetEditor.mode}
        preset={presetEditor.preset}
        currentPlugins={data?.settings.enabledPlugins || {}}
        onClose={handleClosePresetEditor}
        onSave={handleSavePreset}
        onDelete={handleDeletePreset}
        isSaving={saveCustomPreset.isPending}
        isDeleting={deleteCustomPreset.isPending}
      />

      {/* 侧边栏 */}
      <PresetSidebar
        onApplyPreset={handlePresetClick}
        onEditPreset={handleEditPreset}
        onCreatePreset={handleCreatePreset}
        isApplying={applyPreset.isPending}
      />

      {/* 主内容区 */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* 头部 */}
        <header className="flex items-center justify-between px-6 py-4 border-b border-border bg-popover">
          <div>
            <h1 className="text-xl font-semibold text-foreground">
              CC Profile
            </h1>
            <p className="text-sm text-muted-foreground">
              管理 Claude Code 配置
            </p>
          </div>

          <div className="flex items-center gap-4">
            {/* Web 模式：文件选择按钮 */}
            {isWebMode && (
              <button
                onClick={handleOpenFile}
                disabled={isSelectingFile}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                <FolderOpen className="size-4" />
                {isSelectingFile ? "选择中..." : api.isWebFileMode() ? "更换文件" : "选择 settings.json"}
              </button>
            )}
            
            {/* Web 模式：重新加载按钮 */}
            {isWebMode && api.isWebFileMode() && (
              <button
                onClick={handleReloadWebFile}
                className="p-2 rounded-lg hover:bg-card transition-colors"
                title="检测文件变更并重新加载"
              >
                <RefreshCw className="size-4 text-muted-foreground" />
              </button>
            )}
            
            {/* 冲突指示器 */}
            {hasConflict && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-warning/10 text-warning">
                <AlertTriangle className="size-4" />
                <span className="text-sm font-medium">有外部修改</span>
              </div>
            )}

            {/* 配置路径 */}
            <div className="text-xs text-muted-foreground font-mono max-w-[300px] truncate" title={data?.path}>
              {data?.path}
            </div>

            {/* P2-10: 主题切换 */}
            <ThemeToggle />

            {/* 刷新按钮（仅桌面模式） */}
            {!isWebMode && (
              <button
                onClick={refreshSettings}
                className="p-2 rounded-lg hover:bg-card transition-colors"
                title="刷新配置"
              >
                <RefreshCw className="size-4 text-muted-foreground" />
              </button>
            )}
          </div>
        </header>

        {/* Tab 导航 */}
        <nav className="flex gap-1 px-6 py-2 border-b border-border bg-popover">
          <TabButton
            active={activeTab === "plugins"}
            onClick={() => setActiveTab("plugins")}
            icon={<Settings className="size-4" />}
            label="插件管理"
          />
          <TabButton
            active={activeTab === "env"}
            onClick={() => setActiveTab("env")}
            icon={<FileJson className="size-4" />}
            label="环境变量"
          />
          <TabButton
            active={activeTab === "profiles"}
            onClick={() => setActiveTab("profiles")}
            icon={<FolderOpen className="size-4" />}
            label="Profile"
          />
          <TabButton
            active={activeTab === "audit"}
            onClick={() => setActiveTab("audit")}
            icon={<History className="size-4" />}
            label="审计日志"
          />
        </nav>

        {/* 内容区 */}
        <main className="flex-1 overflow-y-auto p-6">
          {/* Web 模式错误提示 */}
          {webFileError && (
            <div className="mb-4 p-4 rounded-lg bg-destructive/10 border border-destructive/20">
              <div className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="size-5" />
                <span className="font-medium">错误</span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{webFileError}</p>
            </div>
          )}
          
          {/* Web 模式：未选择文件提示 */}
          {isWebMode && !api.isWebFileMode() && !isLoading && (
            <div className="flex flex-col items-center justify-center h-[60vh] text-center">
              <FolderOpen className="size-16 text-muted-foreground/75 mb-4" />
              <h2 className="text-xl font-semibold text-foreground mb-2">
                选择配置文件
              </h2>
              <p className="text-muted-foreground mb-6 max-w-md">
                点击上方的"选择 settings.json"按钮，选择您的 Claude Code 配置文件。
                <br />
                <span className="text-xs text-muted-foreground/75">
                  文件通常位于 ~/.claude/settings.json
                </span>
              </p>
              <button
                onClick={handleOpenFile}
                disabled={isSelectingFile}
                className="flex items-center gap-2 px-6 py-3 rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                <FolderOpen className="size-5" />
                {isSelectingFile ? "选择中..." : "选择 settings.json"}
              </button>
              {!api.isFileSystemAccessSupported() && (
                <p className="mt-4 text-sm text-warning">
                  您的浏览器不支持文件选择功能，请使用 Chrome 86+ 或 Edge 86+
                </p>
              )}
            </div>
          )}
          
          {activeTab === "plugins" && (isWebMode ? api.isWebFileMode() : true) && (
            <>
              {/* 详情页视图 */}
              {currentView.type === "detail" && (
                <PluginDetailPage
                  pluginId={currentView.pluginId}
                  isEnabled={data?.settings.enabledPlugins[currentView.pluginId]}
                  onBack={navigateToPluginList}
                  onToggle={handlePluginToggleFromDetail}
                  isToggling={togglePlugin.isPending}
                />
              )}

              {/* 列表视图 */}
              {currentView.type === "list" && (
                <div className="flex gap-6">
                  {/* 左侧：当前配置的插件列表 */}
                  <div className="flex-1 max-w-2xl">
                    <h2 className="text-lg font-semibold mb-4 text-foreground">
                      当前配置
                    </h2>
                    {Object.entries(pluginGroups).map(([groupId, plugins]) => {
                      if (plugins.length === 0) return null;

                      const enabledCount = plugins.filter((p) => p.enabled).length;

                      return (
                        <PluginGroup
                          key={groupId}
                          title={groupLabels[groupId] || groupId}
                          count={{ enabled: enabledCount, total: plugins.length }}
                          expanded={expandedGroups.has(groupId)}
                          onToggleExpand={() => toggleGroupExpanded(groupId)}
                        >
                          {plugins.map((plugin) => (
                            <PluginSwitch
                              key={plugin.id}
                              pluginId={plugin.id}
                              enabled={plugin.enabled}
                              onToggle={(enabled) =>
                                handleTogglePlugin(plugin.id, enabled)
                              }
                              isPending={togglePlugin.isPending}
                              onViewDetail={() => navigateToPluginDetail(plugin.id)}
                            />
                          ))}
                        </PluginGroup>
                      );
                    })}
                  </div>

                  {/* 右侧：官方插件库 */}
                  <div className="w-80 flex-shrink-0 rounded-xl border border-border bg-popover overflow-hidden">
                    <PluginCatalog
                      currentPlugins={data?.settings.enabledPlugins || {}}
                      onRestoreDefaults={handleRestoreDefaults}
                      onPluginClick={handlePluginClick}
                      isRestoring={isRestoringDefaults}
                    />
                  </div>
                </div>
              )}
            </>
          )}

          {activeTab === "env" && (isWebMode ? api.isWebFileMode() : true) && (
            <div className="max-w-2xl">
              <h2 className="text-lg font-semibold mb-4 text-foreground">
                环境变量配置
              </h2>
              <EnvDisplay env={data?.settings.env || {}} />
            </div>
          )}

          {activeTab === "profiles" && (isWebMode ? api.isWebFileMode() : true) && (
            <div className="max-w-2xl">
              <h2 className="text-lg font-semibold mb-4 text-foreground">
                Profile 合并引擎
              </h2>
              {isWebMode ? (
                <p className="text-sm text-muted-foreground">
                  Web 模式不支持 Profile 功能，请使用桌面版。
                </p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground mb-4">
                    从 ~/.claude/profiles/ 目录加载配置 Profile，支持 dry-run 预览和应用。
                  </p>
                  <ProfileMerge onProfileApplied={() => refetch()} />
                </>
              )}
            </div>
          )}

          {activeTab === "audit" && (isWebMode ? api.isWebFileMode() : true) && (
            <div className="max-w-2xl space-y-8">
              {isWebMode ? (
                <p className="text-sm text-muted-foreground">
                  Web 模式不支持备份和审计功能，请使用桌面版。
                </p>
              ) : (
                <>
                  {/* P1-09: 历史回滚 */}
                  <div>
                    <h2 className="text-lg font-semibold mb-4 text-foreground">
                      备份历史与回滚
                    </h2>
                    <HistoryTimeline onRestoreComplete={() => refetch()} />
                  </div>

                  {/* 审计日志 */}
                  <div>
                    <h2 className="text-lg font-semibold mb-4 text-foreground">
                      变更审计日志
                    </h2>
                    <AuditLog limit={20} />
                  </div>
                </>
              )}
            </div>
          )}
        </main>

        {/* 状态栏 */}
        <footer className="flex items-center justify-between px-6 py-2 border-t border-border bg-popover text-xs text-muted-foreground">
          <span>
            最后同步:{" "}
            {data?.modifiedAt
              ? new Date(data.modifiedAt).toLocaleString("zh-CN")
              : "未知"}
          </span>
          <span>Hash: {data?.hash?.slice(0, 12) || "未知"}</span>
        </footer>
      </div>
    </div>
  );
}

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}

function TabButton({ active, onClick, icon, label }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 px-4 py-2 rounded-lg transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "hover:bg-card text-muted-foreground"
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

export default App;
