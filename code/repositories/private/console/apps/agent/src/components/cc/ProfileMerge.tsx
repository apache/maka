/**
 * Profile 合并组件
 * P1-08: cc-dev profile 合并引擎
 */

import { useState, useMemo } from "react";
import {
  FolderOpen,
  RefreshCw,
  ChevronRight,
  CheckCircle,
  AlertCircle,
  Plus,
  Minus,
  Edit,
  Loader2,
  X,
} from "lucide-react";
import { cn } from '@ggbdpq/console-ui';
import {
  useProfiles,
  useMergeProfilePreview,
  useApplyProfile,
} from '@/hooks/cc/useSettings';
import type { ProfileInfo, MergePreview } from '@/lib/cc/api';

interface ProfileMergeProps {
  onProfileApplied?: () => void;
}

export function ProfileMerge({ onProfileApplied }: ProfileMergeProps) {
  const { data: profiles = [], isLoading, error, refetch } = useProfiles();
  const mergePreview = useMergeProfilePreview();
  const applyProfile = useApplyProfile();

  const [selectedProfile, setSelectedProfile] = useState<ProfileInfo | null>(null);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [showPreviewDialog, setShowPreviewDialog] = useState(false);

  const handleProfileSelect = async (profile: ProfileInfo) => {
    setSelectedProfile(profile);
    try {
      const result = await mergePreview.mutateAsync(profile.path);
      setPreview(result as unknown as MergePreview);
      setShowPreviewDialog(true);
    } catch (err) {
      console.error("获取合并预览失败:", err);
    }
  };

  const handleApply = async () => {
    if (!selectedProfile) return;

    try {
      await applyProfile.mutateAsync(selectedProfile.path);
      setShowPreviewDialog(false);
      setPreview(null);
      setSelectedProfile(null);
      onProfileApplied?.();
    } catch (err) {
      console.error("应用 Profile 失败:", err);
    }
  };

  const handleClose = () => {
    setShowPreviewDialog(false);
    setPreview(null);
    setSelectedProfile(null);
  };

  // 统计变更
  const changeStats = useMemo(() => {
    if (!preview) return { added: 0, changed: 0, removed: 0, total: 0 };
    return {
      added: preview.addedKeys.length,
      changed: preview.changedKeys.length,
      removed: preview.removedKeys.length,
      total: preview.addedKeys.length + preview.changedKeys.length + preview.removedKeys.length,
    };
  }, [preview]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">加载 Profile...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20">
        <div className="flex items-center gap-2 text-destructive">
          <AlertCircle className="size-5" />
          <span>加载 Profile 失败: {String(error)}</span>
        </div>
        <button
          onClick={() => refetch()}
          className="mt-2 text-sm text-accent hover:underline"
        >
          重试
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* 标题 */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <FolderOpen className="size-5 text-accent" />
          <h3 className="font-semibold text-foreground">
            Profile 合并
          </h3>
        </div>
        <button
          onClick={() => refetch()}
          className="p-1.5 rounded-lg hover:bg-card transition-colors"
          title="刷新 Profile 列表"
        >
          <RefreshCw className="size-4 text-muted-foreground" />
        </button>
      </div>

      {/* Profile 列表 */}
      {profiles.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <FolderOpen className="size-12 mx-auto mb-3 opacity-50" />
          <p className="mb-2">未找到 Profile</p>
          <p className="text-xs">
            请在 <code className="px-1 py-0.5 rounded bg-card">~/.claude/profiles/</code> 目录创建 JSON 配置文件
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {profiles.map((profile: ProfileInfo) => (
            <ProfileItem
              key={profile.path}
              profile={profile}
              onClick={() => handleProfileSelect(profile)}
              isLoading={mergePreview.isPending && selectedProfile?.path === profile.path}
            />
          ))}
        </div>
      )}

      {/* 预览对话框 */}
      {showPreviewDialog && preview && selectedProfile && (
        <ProfilePreviewDialog
          profile={selectedProfile}
          preview={preview}
          stats={changeStats}
          onApply={handleApply}
          onClose={handleClose}
          isApplying={applyProfile.isPending}
        />
      )}
    </div>
  );
}

interface ProfileItemProps {
  profile: ProfileInfo;
  onClick: () => void;
  isLoading: boolean;
}

function ProfileItem({ profile, onClick, isLoading }: ProfileItemProps) {
  const formatTime = (timestamp: string) => {
    try {
      return new Date(timestamp).toLocaleDateString("zh-CN");
    } catch {
      return "未知";
    }
  };

  return (
    <button
      onClick={onClick}
      disabled={isLoading}
      className={cn(
        "w-full flex items-center gap-3 px-4 py-3 rounded-lg",
        "bg-card hover:bg-background",
        "border border-border",
        "text-left transition-colors",
        isLoading && "opacity-50 cursor-wait"
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="font-medium text-foreground truncate">
          {profile.name}
        </div>
        {profile.description && (
          <div className="text-xs text-muted-foreground truncate mt-0.5">
            {profile.description}
          </div>
        )}
        <div className="text-xs text-muted-foreground mt-1">
          修改于 {formatTime(profile.modifiedAt ?? "")}
        </div>
      </div>
      {isLoading ? (
        <Loader2 className="size-4 animate-spin text-accent" />
      ) : (
        <ChevronRight className="size-4 text-muted-foreground" />
      )}
    </button>
  );
}

interface ProfilePreviewDialogProps {
  profile: ProfileInfo;
  preview: MergePreview;
  stats: { added: number; changed: number; removed: number; total: number };
  onApply: () => void;
  onClose: () => void;
  isApplying: boolean;
}

function ProfilePreviewDialog({
  profile,
  preview,
  stats,
  onApply,
  onClose,
  isApplying,
}: ProfilePreviewDialogProps) {
  const allChanges = useMemo(() => {
    const changes: Array<{ key: string; type: "added" | "changed" | "removed" }> = [];
    
    preview.addedKeys.forEach((key) => changes.push({ key, type: "added" }));
    preview.changedKeys.forEach((key) => changes.push({ key, type: "changed" }));
    preview.removedKeys.forEach((key) => changes.push({ key, type: "removed" }));
    
    return changes;
  }, [preview]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* 背景遮罩 */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* 对话框 */}
      <div
        className={cn(
          "relative w-full max-w-lg mx-4",
          "bg-popover rounded-xl shadow-2xl",
          "overflow-hidden max-h-[80vh] flex flex-col"
        )}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h2 className="font-semibold text-lg text-foreground">
              合并预览: {profile.name}
            </h2>
            {profile.description && (
              <p className="text-sm text-muted-foreground mt-0.5">
                {profile.description}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-card transition-colors"
            disabled={isApplying}
          >
            <X className="size-5 text-muted-foreground" />
          </button>
        </div>

        {/* 变更统计 */}
        <div className="px-5 py-3 bg-card/50 border-b border-border">
          <div className="flex items-center gap-4 text-sm">
            {stats.added > 0 && (
              <span className="flex items-center gap-1 text-success">
                <Plus className="size-4" />
                新增 {stats.added}
              </span>
            )}
            {stats.changed > 0 && (
              <span className="flex items-center gap-1 text-accent">
                <Edit className="size-4" />
                修改 {stats.changed}
              </span>
            )}
            {stats.removed > 0 && (
              <span className="flex items-center gap-1 text-warning">
                <Minus className="size-4" />
                移除 {stats.removed}
              </span>
            )}
            {stats.total === 0 && (
              <span className="text-muted-foreground">
                无变更
              </span>
            )}
          </div>
        </div>

        {/* 变更列表 */}
        <div className="flex-1 overflow-y-auto p-5">
          {allChanges.length === 0 ? (
            <p className="text-center text-muted-foreground py-4">
              该 Profile 不会对当前配置产生任何变更
            </p>
          ) : (
            <div className="space-y-2">
              {allChanges.map(({ key, type }) => (
                <div
                  key={key}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 rounded-lg border",
                    type === "added" && "bg-success/10 border-success/30",
                    type === "changed" && "bg-accent/10 border-accent/30",
                    type === "removed" && "bg-warning/10 border-warning/30"
                  )}
                >
                  {type === "added" && <Plus className="size-4 text-success" />}
                  {type === "changed" && <Edit className="size-4 text-accent" />}
                  {type === "removed" && <Minus className="size-4 text-warning" />}
                  <span className="font-mono text-sm text-foreground truncate">
                    {key}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-border">
          <button
            onClick={onClose}
            className="btn-secondary"
            disabled={isApplying}
          >
            取消
          </button>
          <button
            onClick={onApply}
            className="btn-primary flex items-center gap-2"
            disabled={isApplying || stats.total === 0}
          >
            {isApplying ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                应用中...
              </>
            ) : (
              <>
                <CheckCircle className="size-4" />
                确认应用
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
