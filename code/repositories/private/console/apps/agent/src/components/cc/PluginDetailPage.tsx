/**
 * 插件详情页（独立页面，非弹窗）
 * 展示插件的详细信息：问题、场景、限制、配置、安全说明、调用统计
 */

import { ArrowLeft, ExternalLink, CheckCircle, XCircle, AlertTriangle, Code, Shield, Lightbulb, FileText, Power } from "lucide-react";
import { getCatalogEntry, getCategoryLabel, getPluginUsageStats } from '@/data/cc/pluginCatalog';
import { Switch } from './Switch';
import { cn } from '@ggbdpq/console-ui';

interface PluginDetailPageProps {
  /** 插件 ID */
  pluginId: string;
  /** 当前启用状态 */
  isEnabled: boolean | undefined;
  /** 返回列表 */
  onBack: () => void;
  /** 切换启用状态 */
  onToggle: (enabled: boolean) => void;
  /** 是否正在切换 */
  isToggling?: boolean;
}

export function PluginDetailPage({
  pluginId,
  isEnabled,
  onBack,
  onToggle,
  isToggling = false,
}: PluginDetailPageProps) {
  const entry = getCatalogEntry(pluginId);
  const usageStats = getPluginUsageStats(pluginId);

  // 插件不存在
  if (!entry) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-20">
        <AlertTriangle className="size-16 text-warning mb-4" />
        <h2 className="text-xl font-semibold text-foreground mb-2">
          未找到该插件
        </h2>
        <p className="text-muted-foreground mb-6">
          插件 ID: <code className="px-2 py-0.5 rounded bg-card">{pluginId}</code>
        </p>
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors"
        >
          <ArrowLeft className="size-4" />
          返回插件列表
        </button>
      </div>
    );
  }

  const currentStatus: "enabled" | "disabled" | "unknown" = 
    isEnabled === true ? "enabled" : isEnabled === false ? "disabled" : "unknown";

  return (
    <div className="max-w-3xl mx-auto">
      {/* 顶部导航 */}
      <div className="flex items-center justify-between mb-6">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-muted-foreground hover:bg-card transition-colors"
        >
          <ArrowLeft className="size-4" />
          返回插件列表
        </button>
      </div>

      {/* 标题区 */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl font-bold text-foreground">
              {entry.displayName}
            </h1>
            <span
              className={cn(
                "px-2.5 py-1 rounded-full text-xs font-medium",
                currentStatus === "enabled" && "bg-success/10 text-success",
                currentStatus === "disabled" && "bg-muted-foreground/10 text-muted-foreground/75",
                currentStatus === "unknown" && "bg-warning/10 text-warning"
              )}
            >
              {currentStatus === "enabled" ? "已启用" : currentStatus === "disabled" ? "已禁用" : "未配置"}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {getCategoryLabel(entry.category)} · {entry.publisher}
          </p>
        </div>

        {/* 启用/禁用开关 */}
        {currentStatus !== "unknown" && (
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {isEnabled ? "已启用" : "已禁用"}
            </span>
            <Switch
              checked={isEnabled || false}
              onCheckedChange={onToggle}
              disabled={isToggling}
            />
          </div>
        )}
      </div>

      {/* 内容区 */}
      <div className="space-y-6">
        {/* 一句话说明 */}
        <Section
          icon={<Lightbulb className="size-5" />}
          title="解决什么问题"
        >
          <p className="text-base text-foreground">
            {entry.problem}
          </p>
        </Section>

        {/* 适用场景 */}
        <Section
          icon={<CheckCircle className="size-5 text-success" />}
          title="适用场景"
        >
          <ul className="space-y-2">
            {entry.useCases.map((useCase, index) => (
              <li
                key={index}
                className="flex items-start gap-3 text-foreground"
              >
                <span className="text-success mt-0.5">•</span>
                {useCase}
              </li>
            ))}
          </ul>
        </Section>

        {/* 不适用/限制 */}
        <Section
          icon={<XCircle className="size-5 text-destructive" />}
          title="不适用 / 限制"
        >
          <ul className="space-y-2">
            {entry.limitations.map((limitation, index) => (
              <li
                key={index}
                className="flex items-start gap-3 text-foreground"
              >
                <span className="text-destructive mt-0.5">•</span>
                {limitation}
              </li>
            ))}
          </ul>
        </Section>

        {/* 配置项 */}
        <Section
          icon={<Code className="size-5" />}
          title="相关配置项"
        >
          <div className="space-y-2">
            {entry.configKeys.map((key, index) => (
              <code
                key={index}
                className="block text-sm px-3 py-2 rounded-lg bg-card font-mono text-foreground"
              >
                {key}
              </code>
            ))}
          </div>
        </Section>

        {/* 安全说明 */}
        <Section
          icon={<Shield className="size-5 text-warning" />}
          title="安全说明"
        >
          <ul className="space-y-2">
            {entry.securityNotes.map((note, index) => (
              <li
                key={index}
                className="flex items-start gap-3 text-foreground"
              >
                <AlertTriangle className="size-4 text-warning mt-0.5 flex-shrink-0" />
                {note}
              </li>
            ))}
          </ul>
        </Section>

        {/* 调用统计 */}
        <Section
          icon={<FileText className="size-5" />}
          title="本项目调用统计"
        >
          {usageStats ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between py-2 border-b border-border">
                <span className="text-muted-foreground">引用次数</span>
                <span className="text-lg font-semibold text-foreground">
                  {usageStats.referenceCount} 次
                </span>
              </div>
              {usageStats.files.length > 0 && (
                <div>
                  <p className="text-sm text-muted-foreground mb-2">引用文件：</p>
                  <div className="space-y-1">
                    {usageStats.files.map((file, index) => (
                      <code
                        key={index}
                        className="block text-sm px-3 py-2 rounded-lg bg-card font-mono text-foreground"
                      >
                        {file}
                      </code>
                    ))}
                  </div>
                </div>
              )}
              <p className="text-xs text-muted-foreground/75">
                扫描时间: {new Date(usageStats.scannedAt).toLocaleString("zh-CN")}
              </p>
            </div>
          ) : (
            <div className="py-4 text-center text-muted-foreground">
              <p>暂无统计数据</p>
              <p className="text-sm mt-1">
                运行 <code className="px-2 py-0.5 rounded bg-card text-xs">pnpm scan:plugins</code> 生成统计
              </p>
            </div>
          )}
        </Section>

        {/* 状态说明（如果有） */}
        {entry.statusNotes && (
          <Section
            icon={<AlertTriangle className="size-5 text-warning" />}
            title="状态说明"
          >
            <p className="text-warning">
              {entry.statusNotes}
            </p>
          </Section>
        )}

        {/* 相关链接（如果有） */}
        {entry.homepage && (
          <Section
            icon={<ExternalLink className="size-5" />}
            title="相关链接"
          >
            <a
              href={entry.homepage}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-accent hover:underline"
            >
              查看官方文档
              <ExternalLink className="size-4" />
            </a>
          </Section>
        )}
      </div>

      {/* 底部操作区 */}
      <div className="mt-10 pt-6 border-t border-border">
        <div className="flex items-center justify-between">
          <button
            onClick={onBack}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-muted-foreground hover:bg-card transition-colors"
          >
            <ArrowLeft className="size-4" />
            返回插件列表
          </button>

          {currentStatus !== "unknown" && (
            <button
              onClick={() => onToggle(!isEnabled)}
              disabled={isToggling}
              className={cn(
                "flex items-center gap-2 px-5 py-2.5 rounded-lg font-medium transition-colors",
                isEnabled
                  ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
                  : "bg-primary text-primary-foreground hover:bg-primary/90",
                isToggling && "opacity-50 cursor-not-allowed"
              )}
            >
              <Power className="size-4" />
              {isToggling ? "处理中..." : isEnabled ? "禁用此插件" : "启用此插件"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 内容分区组件
 */
function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="p-5 rounded-xl bg-popover border border-border">
      <div className="flex items-center gap-3 text-muted-foreground mb-4">
        {icon}
        <h3 className="text-base font-semibold">{title}</h3>
      </div>
      {children}
    </div>
  );
}
