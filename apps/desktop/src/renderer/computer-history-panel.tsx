import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import {
  Clock,
  Play,
  RefreshCcw,
  ShieldCheck,
  Square,
  Trash2,
} from '@maka/ui/icons';
import { IconButton, Switch, useToast, useUiLocale } from '@maka/ui';
import type {
  ComputerHistoryStatus,
  ComputerHistoryTimeline,
  ComputerHistoryTimelineEntry,
} from '@maka/core/computer-history';

export function ComputerHistoryPanel(props: {
  active: boolean;
  onAppendContext(context: string): void;
}) {
  const locale = useUiLocale();
  const copy = locale === 'zh' ? ZH : EN;
  const toast = useToast();
  const [timeline, setTimeline] = useState<ComputerHistoryTimeline | null>(null);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTimeline(await window.maka.computerHistory.timeline(7));
    } catch (nextError) {
      setError(message(nextError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!props.active) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [props.active, refresh]);

  async function run(key: string, operation: () => Promise<unknown>) {
    if (action) return;
    setAction(key);
    setError(null);
    try {
      await operation();
      await refresh();
    } catch (nextError) {
      setError(message(nextError));
    } finally {
      setAction(null);
    }
  }

  const status = timeline?.status;
  return (
    <div className="computerHistoryPanel" aria-label={copy.title}>
      <header className="computerHistoryHeader">
        <div>
          <Heading level={3}>{copy.title}</Heading>
          <Text size="sm" color="secondary">{copy.subtitle}</Text>
        </div>
        <IconButton
          label={copy.refresh}
          icon={<RefreshCcw size={16} aria-hidden />}
          size="sm"
          isDisabled={loading}
          onClick={() => void refresh()}
        />
      </header>

      {status ? (
        <HistoryControlStrip
          status={status}
          busy={action !== null}
          copy={copy}
          onToggle={(enabled) =>
            void run('enabled', () =>
              window.maka.computerHistory.updateSettings({ enabled }),
            )
          }
          onPermissions={() =>
            void run('permissions', () =>
              window.maka.computerHistory.requestPermissions(),
            )
          }
          onPause={() =>
            void run('pause', () => window.maka.computerHistory.pause())
          }
          onResume={() =>
            void run('resume', () => window.maka.computerHistory.resume())
          }
          onClear={() => {
            if (!window.confirm(copy.clearConfirm)) return;
            void run('clear', () => window.maka.computerHistory.clear('all'));
          }}
        />
      ) : null}

      {error ? <div className="computerHistoryError" role="alert">{error}</div> : null}

      <div className="computerHistoryTimeline" aria-busy={loading}>
        {timeline?.entries.length ? (
          timeline.entries.map((entry) => (
            <HistoryEntry
              key={entry.id}
              entry={entry}
              copy={copy}
              onAppend={() => {
                props.onAppendContext(entry.contextMarkdown);
                toast.success(copy.added, entry.title);
              }}
            />
          ))
        ) : (
          <div className="computerHistoryEmpty">
            <Clock size={22} aria-hidden />
            <Heading level={4}>{copy.empty}</Heading>
            <Text size="sm" color="secondary">
              {status?.state === 'needs_permission' ? copy.permissionEmpty : copy.emptyHelp}
            </Text>
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryControlStrip(props: {
  status: ComputerHistoryStatus;
  busy: boolean;
  copy: ComputerHistoryCopy;
  onToggle(enabled: boolean): void;
  onPermissions(): void;
  onPause(): void;
  onResume(): void;
  onClear(): void;
}) {
  const { status } = props;
  const needsPermission = status.state === 'needs_permission';
  const running = status.state === 'running';
  const paused = status.state === 'paused';
  return (
    <section className="computerHistoryControls" aria-label={props.copy.controls}>
      <div className="computerHistoryStatusRow">
        <div className="computerHistoryStatus">
          <span className="computerHistoryStatusDot" data-state={status.state} />
          <span>{props.copy.states[status.state]}</span>
          <Badge variant="neutral" label={props.copy.events(status.eventCount)} />
        </div>
        <Switch
          label={props.copy.enabled}
          isLabelHidden
          value={status.settings.enabled}
          isDisabled={props.busy || !status.platformSupported || !status.helperAvailable}
          onChange={props.onToggle}
        />
      </div>
      <div className="computerHistoryActions">
        {needsPermission ? (
          <Button label={props.copy.permissions} size="sm" variant="primary" isDisabled={props.busy} onClick={props.onPermissions}>
            <ShieldCheck size={15} aria-hidden />
            {props.copy.permissions}
          </Button>
        ) : running ? (
          <Button label={props.copy.pause} size="sm" variant="secondary" isDisabled={props.busy} onClick={props.onPause}>
            <Square size={15} aria-hidden />
            {props.copy.pause}
          </Button>
        ) : paused ? (
          <Button label={props.copy.resume} size="sm" variant="secondary" isDisabled={props.busy} onClick={props.onResume}>
            <Play size={15} aria-hidden />
            {props.copy.resume}
          </Button>
        ) : null}
        <IconButton
          label={props.copy.clear}
          icon={<Trash2 size={15} aria-hidden />}
          size="sm"
          variant="ghost"
          isDisabled={props.busy || status.eventCount === 0}
          onClick={props.onClear}
        />
      </div>
      <Text size="sm" color="secondary">
        {status.settings.captureText ? props.copy.textOn : props.copy.textOff}
      </Text>
    </section>
  );
}

function HistoryEntry(props: {
  entry: ComputerHistoryTimelineEntry;
  copy: ComputerHistoryCopy;
  onAppend(): void;
}) {
  return (
    <article className="computerHistoryEntry">
      <div className="computerHistoryEntryTime">
        <time dateTime={props.entry.start}>{formatTime(props.entry.start)}</time>
        <span>{duration(props.entry.start, props.entry.end)}</span>
      </div>
      <div className="computerHistoryEntryBody">
        <Heading level={4}>{props.entry.title}</Heading>
        <Text size="sm" color="secondary">{props.entry.description}</Text>
        <div className="computerHistoryEntryMeta">
          {props.entry.applications.slice(0, 3).map((app) => (
            <span key={app}>{shortApp(app)}</span>
          ))}
        </div>
      </div>
      <Button label={props.copy.addToChat} size="sm" variant="ghost" onClick={props.onAppend}>
        {props.copy.addToChat}
      </Button>
    </article>
  );
}

type ComputerHistoryCopy = {
  title: string;
  subtitle: string;
  controls: string;
  enabled: string;
  refresh: string;
  permissions: string;
  pause: string;
  resume: string;
  clear: string;
  clearConfirm: string;
  empty: string;
  emptyHelp: string;
  permissionEmpty: string;
  addToChat: string;
  added: string;
  textOn: string;
  textOff: string;
  events(count: number): string;
  states: Record<ComputerHistoryStatus['state'], string>;
};

const ZH: ComputerHistoryCopy = {
  title: '电脑历史',
  subtitle: '本机交互事件，默认不保存输入文本',
  controls: '电脑历史控制',
  enabled: '启用电脑历史',
  refresh: '刷新电脑历史',
  permissions: '授予权限',
  pause: '暂停',
  resume: '继续',
  clear: '清除',
  clearConfirm: '永久清除 Maka 记录的全部电脑历史？此操作无法撤销。',
  empty: '还没有可显示的活动',
  emptyHelp: '启用后，应用切换、窗口、点击和快捷键会在本机形成时间线。',
  permissionEmpty: '需要辅助功能和输入监控权限后才能开始记录。',
  addToChat: '加入对话',
  added: '已加入 Composer',
  textOn: '输入文本采集已开启；密码框和隐私浏览仍会被抑制。',
  textOff: '输入文本采集关闭；只保留应用、窗口和交互类型。',
  events: (count: number) => `${count} 条事件`,
  states: {
    unsupported: '当前平台不支持',
    stopped: '已停止',
    running: '记录中',
    paused: '已暂停',
    needs_permission: '等待权限',
    unavailable: '采集器不可用',
    error: '采集器出错',
  },
};

const EN: ComputerHistoryCopy = {
  title: 'Computer History',
  subtitle: 'Local interaction events with typed text off by default',
  controls: 'Computer History controls',
  enabled: 'Enable Computer History',
  refresh: 'Refresh Computer History',
  permissions: 'Grant permissions',
  pause: 'Pause',
  resume: 'Resume',
  clear: 'Clear',
  clearConfirm: 'Permanently clear all Computer History recorded by Maka? This cannot be undone.',
  empty: 'No activity yet',
  emptyHelp: 'Once enabled, app switches, windows, clicks, and shortcuts form a local timeline.',
  permissionEmpty: 'Accessibility and Input Monitoring permissions are required to start recording.',
  addToChat: 'Add to chat',
  added: 'Added to Composer',
  textOn: 'Typed text capture is on. Secure fields and private browsing remain suppressed.',
  textOff: 'Typed text capture is off. Only apps, windows, and interaction types are retained.',
  events: (count: number) => `${count} events`,
  states: {
    unsupported: 'Unsupported platform',
    stopped: 'Stopped',
    running: 'Recording',
    paused: 'Paused',
    needs_permission: 'Permissions needed',
    unavailable: 'Collector unavailable',
    error: 'Collector error',
  },
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function duration(start: string, end: string): string {
  const minutes = Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 60_000));
  return `${minutes}m`;
}

function shortApp(value: string): string {
  return value.split('.').at(-1) || value;
}
