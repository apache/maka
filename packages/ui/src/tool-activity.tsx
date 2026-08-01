import { useEffect, useRef, useState, type ComponentType } from 'react';
import type { ToolResultContent } from '@maka/core';
import {
  Check,
  Clock,
  Copy,
  FileText,
  Globe,
  Repeat,
  Search,
  Settings,
  ShieldAlert,
  SquarePen,
  Terminal,
  type LucideProps,
} from './icons.js';
import { useClipboardCopyFeedback } from './clipboard-feedback.js';
import { useUiLocale } from './locale-context.js';
import { type ToolActivityItem, type ToolOutputChunk } from './materialize.js';
import {
  isTrowRunning,
  summarizeTrowTools,
  trowNeedsAttention,
  type TrowActivityKind,
} from './tool-activity/trow-summary.js';
import { isToolRowRunning, isToolRowSettled } from './tool-activity/tool-row-motion.js';
import {
  createToolDisclosureState,
  deriveToolActivityPresentation,
  isConnectorTool,
  resolveToolDisplayName,
  setToolDisclosureOpen,
  syncToolDisclosureState,
  type ToolActivityPresentation,
} from './tool-activity/presentation.js';
import {
  extractErrorText,
  isAutomationTool,
  isCancelledToolResult,
  isPermissionDeniedToolResult,
  resultOwnsOwnPanel,
  toolStatusLabel,
  withLiveStreamFallback,
} from './tool-activity/result-projection.js';
import { isSandboxDeniedTool } from './tool-activity/sandbox-denial.js';
import { previewVariants, TextShimmer, toolVariants } from './primitives/chat.js';
import { redactSecrets } from './redact.js';
import {
  Button as UiButton,
  Banner,
  ChatToolCalls,
  Collapsible as AstryxCollapsible,
  type ChatToolCallItem,
} from '@astryxdesign/core';
import { ToolCodeBlock, ToolDetailReveal } from './tool-activity/tool-code-block.js';
import { cn } from './ui.js';
import { describeLoadToolResult, formatToolIntent } from './tool-format.js';
import {
  formatDuration,
  formatUserVisibleToolText,
  summarizeErrorText,
} from './tool-activity/preview-utils.js';
import {
  formatQuietJsonValue,
  formatToolInvocationLine,
} from './tool-activity/builtin-preview.js';
import {
  TOOL_OUTPUT_BODY_CLASS,
  TOOL_OUTPUT_COMMAND_CLASS,
  TOOL_OUTPUT_NOTE_CLASS,
  TOOL_OUTPUT_PANEL_CLASS,
  ToolResultPreview,
} from './tool-activity/tool-result-preview.js';
import { getToolActivityCopy } from './tool-activity/copy.js';

/** Friendly card for a `load_tools` result; falls back to JSON on unexpected shapes. */
function LoadToolResultPreview(props: { args: unknown; value: unknown }) {
  const locale = useUiLocale();
  const desc = describeLoadToolResult(props.args, props.value, locale);
  if (!desc) {
    return <ToolResultPreview content={{ kind: 'json', value: props.value }} />;
  }
  return (
    <div className={previewVariants({ part: 'load-tool' })} data-kind="load_tool">
      <p className={previewVariants({ part: 'load-tool-title' })}>{desc.title}</p>
      <p className={previewVariants({ part: 'load-tool-count' })}>{desc.countLabel}</p>
      <p className={previewVariants({ part: 'load-tool-tools' })}>{desc.toolsText}</p>
      <p className={previewVariants({ part: 'load-tool-footer' })}>{desc.footer}</p>
    </div>
  );
}

// ── Automation result preview ───────────────────────────────────────────────

const AUTOMATION_RESULT_ICON_CLASS = 'inline align-text-bottom mr-1';

/** Icon for one automation description: recurring schedules cycle, one-shots tick. */
function automationScheduleIcon(text: string): ComponentType<LucideProps> {
  return /Schedule: (every |cron )/.test(text) ? Repeat : Clock;
}

/**
 * Compact preview card for the unified Automation tool's text results
 * (created / deleted / listed). The tool returns human-readable text, so this
 * parses its stable first-line shapes; anything unrecognized (pause/resume,
 * errors) falls back to the generic text preview.
 */
function AutomationResultPreview(props: { text: string }) {
  const copy = getToolActivityCopy(useUiLocale()).automation;
  const text = props.text;

  // mode:create success — "Automation created: "NAME" (kind[, durable])\nID: …\nSchedule: …\nNext fire: …"
  const created = text.match(/^Automation created: "(.+?)" \((.+?)\)\n/);
  if (created) {
    const schedule = text.match(/^Schedule: (.+)$/m)?.[1];
    const nextFire = text.match(/^Next fire: (.+)$/m)?.[1];
    const Icon = automationScheduleIcon(text);
    return (
      <div className={previewVariants({ part: 'load-tool' })} data-kind="automation_create">
        <p className={previewVariants({ part: 'load-tool-title' })}>
          <Icon size={14} aria-hidden="true" className={AUTOMATION_RESULT_ICON_CLASS} />
          {copy.created(redactSecrets(created[1] ?? ''))}
        </p>
        {schedule && <p className={previewVariants({ part: 'load-tool-count' })}>{redactSecrets(schedule)}</p>}
        {nextFire && nextFire !== 'N/A' && <p className={previewVariants({ part: 'load-tool-tools' })}>{copy.nextFire(redactSecrets(nextFire))}</p>}
        <p className={previewVariants({ part: 'load-tool-footer' })}>{redactSecrets(created[2] ?? '')}</p>
      </div>
    );
  }

  // mode:delete — "Automation "id" deleted." / not-found message
  const deleted = text.match(/^Automation "(.+?)" (deleted\.|not found or not owned by this session\.)$/);
  if (deleted) {
    const ok = deleted[2] === 'deleted.';
    return (
      <div className={previewVariants({ part: 'load-tool' })} data-kind="automation_delete">
        <p className={previewVariants({ part: 'load-tool-title' })}>
          <Check size={14} aria-hidden="true" className={AUTOMATION_RESULT_ICON_CLASS} />
          {ok ? copy.deleted : copy.notFound}
        </p>
      </div>
    );
  }

  // mode:list — automation blocks separated by "---", or the empty-list message.
  const isList = text === 'No automations for this session.' || /^\[[A-Z]+\] .+ \((heartbeat|cron)/.test(text);
  if (isList) {
    const blocks = text === 'No automations for this session.' ? [] : text.split('\n---\n');
    return (
      <div className={previewVariants({ part: 'load-tool' })} data-kind="automation_list">
        <p className={previewVariants({ part: 'load-tool-title' })}>
          <Clock size={14} aria-hidden="true" className={AUTOMATION_RESULT_ICON_CLASS} />
          {copy.list(blocks.length)}
        </p>
        {blocks.length === 0 && <p className={previewVariants({ part: 'load-tool-count' })}>{copy.empty}</p>}
        {blocks.slice(0, 5).map((block, i) => {
          const head = block.split('\n')[0] ?? '';
          const BlockIcon = automationScheduleIcon(block);
          return (
            <p key={i} className={previewVariants({ part: 'load-tool-tools' })}>
              <BlockIcon size={12} aria-hidden="true" className={AUTOMATION_RESULT_ICON_CLASS} />
              {redactSecrets(head)}
            </p>
          );
        })}
      </div>
    );
  }

  // Fallback for pause/resume confirmations, errors, or unexpected shapes.
  return <ToolResultPreview content={{ kind: 'text', text }} />;
}

export function useToolDisclosure(presentation: ToolActivityPresentation) {
  const [disclosure, setDisclosure] = useState(() => createToolDisclosureState(presentation));
  useEffect(() => {
    setDisclosure((current) => syncToolDisclosureState(current, presentation));
  }, [presentation.needsAttention]);
  return {
    open: disclosure.open,
    setOpen: (open: boolean) => setDisclosure((current) => setToolDisclosureOpen(current, open)),
  };
}

export function ToolActivity(props: {
  items: ToolActivityItem[];
  /** Controlled open state applied to every card. When omitted each card
   *  manages its own disclosure (permission prompts open; errored tools stay
   *  collapsed). Passed by tests to render the expanded state in static
   *  markup; production callers leave it uncontrolled. */
  open?: boolean;
}) {
  const copy = getToolActivityCopy(useUiLocale()).group;
  return (
    <section className={toolVariants({ part: 'container' })} aria-label={copy.ariaLabel}>
      <header className={toolVariants({ part: 'container-header' })}>
        <strong>{copy.title}</strong>
        <span className={toolVariants({ part: 'count' })} aria-label={copy.callCount(props.items.length)}>{props.items.length}</span>
      </header>
      {props.items.map((item) => (
        <ToolActivityCard key={item.toolUseId} item={item} open={props.open} />
      ))}
    </section>
  );
}

function ToolActivityCard({ item, open: openProp }: { item: ToolActivityItem; open?: boolean }) {
  const locale = useUiLocale();
  // Controlled disclosure: product open-on-permission state, not Astryx defaultIsOpen.
  const presentation = deriveToolActivityPresentation(item, locale);
  const disclosure = useToolDisclosure(presentation);
  const open = openProp ?? disclosure.open;
  const duration = formatDuration(item.durationMs);
  const visualStatus = isSandboxDeniedTool(item) ? 'blocked' : item.status;
  return (
    <AstryxCollapsible
      data-slot="tool"
      className={toolVariants({ part: 'item' })}
      data-status={visualStatus}
      isOpen={open}
      onOpenChange={disclosure.setOpen}
      trigger={(
        <span className={cn('w-full', toolVariants({ part: 'header' }))}>
          <span className={toolVariants({ part: 'dot' })} data-status={visualStatus} aria-hidden="true" />
          <span className={toolVariants({ part: 'name' })}>{resolveToolDisplayName(item, locale)}</span>
          <span className={toolVariants({ part: 'meta' })}>
            {duration && <span className={toolVariants({ part: 'duration' })}>{duration}</span>}
            <span className={toolVariants({ part: 'status-label' })}>{toolStatusLabel(item, locale)}</span>
          </span>
        </span>
      )}
    >
      {open ? (
        <ToolDetailReveal>
          <ToolCardBody item={item} />
        </ToolDetailReveal>
      ) : null}
    </AstryxCollapsible>
  );
}

function ToolCardBody({ item }: { item: ToolActivityItem }) {
  const locale = useUiLocale();
  const cancelled = isCancelledToolResult(item.result);
  const sandboxBlocked = isSandboxDeniedTool(item);
  // Cancel is not a failure; stale errored+cancelled must not paint as failed.
  const failedOutcome = item.status === 'errored' && !cancelled;
  const permissionDenied = isPermissionDeniedToolResult(item.result);
  const running = item.status === 'running' || item.status === 'pending';
  const ptyControlResult = item.toolName === 'WriteStdin' && item.result?.kind === 'shell_run';
  const ownsPanel = resultOwnsOwnPanel(item);
  // Sandbox only — ordinary failures use ChatToolCalls status=error on the row.
  const showSandboxBanner = sandboxBlocked && failedOutcome && !ptyControlResult;
  // Skip invocation when the owned panel already prints the command.
  const invocationLine = !permissionDenied && !ownsPanel
    ? formatToolInvocationLine(item, locale)
    : undefined;
  // Live stream or settled result — never both (owned panels use withLiveStreamFallback).
  const showLiveStream = !!item.outputChunks
    && item.outputChunks.length > 0
    && !ownsPanel
    && (running || !item.result);
  const showResult = !!item.result && !permissionDenied;
  const displayResult = showResult && item.result
    ? withLiveStreamFallback(item.result, item.outputChunks, {
      truncated: item.outputTruncated === true,
      locale,
    })
    : undefined;
  const quietJson =
    displayResult?.kind === 'json'
      ? formatQuietJsonValue(displayResult.value, locale)
      : undefined;
  // Drop headline when it duplicates the invocation (e.g. Write path === path).
  const showInvocation = invocationLine !== undefined;
  const resultHeadline = quietJson?.headline
    && quietJson.headline !== invocationLine
    ? quietJson.headline
    : undefined;
  const hasSharedPanelContent =
    !ownsPanel && (
      showInvocation
      || !!resultHeadline
      || showLiveStream
      || showResult
      || (!!item.args && !permissionDenied && !invocationLine && !showResult && !showLiveStream)
    );

  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {showSandboxBanner && (
        <SandboxBlockedBanner result={displayResult ?? item.result} />
      )}
      {showResult && ownsPanel && displayResult && (
        isConnectorTool(item.toolName) && displayResult.kind === 'json' ? (
          <LoadToolResultPreview args={item.args} value={displayResult.value} />
        ) : isAutomationTool(item.toolName) && displayResult.kind === 'text' ? (
          <AutomationResultPreview text={displayResult.text} />
        ) : (
          <ToolResultPreview
            content={displayResult}
            toolName={item.toolName}
            args={item.args}
            shellRunSource={item.shellRunSource}
          />
        )
      )}
      {hasSharedPanelContent && (
        <div data-slot="tool-output" className="mt-1 flex min-w-0 flex-col gap-1.5">
          {showLiveStream && (
            <>
              {showInvocation && invocationLine ? (
                <ToolCodeBlock code={invocationLine} />
              ) : null}
              <ToolOutputStream
                chunks={item.outputChunks!}
                live={running}
                truncated={item.outputTruncated === true}
              />
            </>
          )}
          {!showLiveStream && (() => {
            const argsBody = !showInvocation && !resultHeadline && item.args !== undefined
              && !permissionDenied && !showResult
              ? formatQuietJsonValue(item.args, locale).body
              : undefined;
            const body = quietJson?.body ?? argsBody;
            const title = resultHeadline ?? (showInvocation ? invocationLine : undefined);
            if (body) {
              return (
                <ToolCodeBlock
                  code={body}
                  // Only raw args dumps are JSON; quiet bodies stay untokenized.
                  language={argsBody ? 'json' : undefined}
                  title={title}
                />
              );
            }
            if (showInvocation && invocationLine && !showResult) {
              return <ToolCodeBlock code={invocationLine} />;
            }
            if (showResult && !ownsPanel && displayResult) {
              return <ToolResultPreview content={displayResult} toolName={item.toolName} />;
            }
            if (showInvocation && invocationLine) {
              return <ToolCodeBlock code={invocationLine} />;
            }
            return null;
          })()}
        </div>
      )}
    </div>
  );
}

// Per-bucket icon for a trow's summary row + flat tool rows. Kept here (not in
// the pure summary module) because icons are React components.
const TROW_KIND_ICON: Record<TrowActivityKind, ComponentType<LucideProps>> = {
  read: FileText,
  search: Search,
  websearch: Globe,
  webfetch: Globe,
  edit: SquarePen,
  command: Terminal,
  explore: Search,
  browser: Globe,
  tool: Settings,
};

export function ToolKindIcon({ kind, ...props }: LucideProps & { kind: TrowActivityKind }) {
  const Icon = TROW_KIND_ICON[kind];
  return <Icon {...props} />;
}

// Group settle landing; only when the group was seen running this session.
export const SETTLE_FADE = '[animation:maka-stream-fade-in_var(--duration-emphasized)_var(--ease-out-strong)_both]';

/** Astryx ChatToolCalls for ordinary tools; product trow for permission/sandbox/interrupted. */
export function ToolTrow({
  items,
  variant = 'group',
}: {
  items: ToolActivityItem[];
  variant?: 'group' | 'rows';
}) {
  if (items.length === 0) return null;
  if (items.every(supportsAstryxToolCall)) {
    return <AstryxToolCalls items={items} />;
  }
  if (variant === 'rows') {
    return items.map((item) => <ToolTrowRow key={item.toolUseId} item={item} />);
  }
  return <ToolTrowGroup items={items} />;
}

function supportsAstryxToolCall(item: ToolActivityItem): boolean {
  return !isSandboxDeniedTool(item)
    && item.status !== 'waiting_permission'
    && item.status !== 'interrupted';
}

function astryxToolStatus(item: ToolActivityItem): ChatToolCallItem['status'] {
  switch (item.status) {
    case 'completed': return 'complete';
    case 'errored': return 'error';
    case 'running': return 'running';
    default: return 'pending';
  }
}

function AstryxToolCalls({ items }: { items: ToolActivityItem[] }) {
  const locale = useUiLocale();
  const calls: ChatToolCallItem[] = items.map((item) => ({
    key: item.toolUseId,
    name: resolveToolDisplayName(item, locale),
    status: astryxToolStatus(item),
    target: item.intent ? formatToolIntent(item.intent) : undefined,
    duration: formatDuration(item.durationMs) ?? undefined,
    errorMessage: item.status === 'errored'
      ? summarizeErrorText(formatUserVisibleToolText(
          redactSecrets(extractErrorText(item.result, locale)),
          locale,
        )).replace(/^Error:\s*/i, '')
      : undefined,
    resultDetail: (
      <ToolDetailReveal>
        <ToolCardBody item={item} />
      </ToolDetailReveal>
    ),
  }));

  return (
    <ChatToolCalls
      calls={calls}
      label={summarizeTrowTools(items, { locale })}
      defaultIsExpanded={items.some((item) => item.status === 'running')}
    />
  );
}

function ToolTrowGroup({ items }: { items: ToolActivityItem[] }) {
  const locale = useUiLocale();
  const running = isTrowRunning(items);
  const attention = trowNeedsAttention(items);
  const firstPresentation = deriveToolActivityPresentation(items[0]!, locale);
  const disclosure = useToolDisclosure({ ...firstPresentation, needsAttention: attention });
  // Settle fade only if this session saw the group running (not a replayed transcript).
  const everRunningRef = useRef(false);
  if (running) everRunningRef.current = true;
  const settled = !running;
  const settling = settled && everRunningRef.current;
  const hasSandboxBlocked = items.some(isSandboxDeniedTool);
  const hasError = items.some(
    (item) => item.status === 'errored' && !isSandboxDeniedTool(item),
  );
  const settledTone = hasError
    ? 'text-[color:var(--destructive)]'
    : hasSandboxBlocked
      ? 'text-[color:var(--warning-text,var(--info-text))]'
      : 'text-[color:var(--muted-foreground)]';
  // Icon + multi-tool summary stay first-bucket stable so parallel tools don't jitter.
  const summary = running
    ? (items.length > 1 ? summarizeTrowTools(items, { live: true, locale }) : firstPresentation.summary)
    : summarizeTrowTools(items, { locale });
  return (
    <AstryxCollapsible
      className="flex flex-col"
      data-trow="group"
      data-settled={settled ? 'true' : undefined}
      isOpen={disclosure.open}
      onOpenChange={disclosure.setOpen}
      trigger={(
        <span className="flex min-w-0 items-center gap-[length:var(--spacing-1-5,0.375rem)] py-0.5">
          <ToolKindIcon kind={firstPresentation.kind} size={16} aria-hidden="true" className={cn('shrink-0', settledTone)} />
          {running ? (
            <TextShimmer active delayed className="min-w-0 truncate text-[length:var(--text-supporting-size)] font-medium">{summary}</TextShimmer>
          ) : (
            <span className={cn('min-w-0 truncate text-[length:var(--text-supporting-size)] font-medium', settledTone, settling && SETTLE_FADE)}>{summary}</span>
          )}
        </span>
      )}
    >
      {disclosure.open
        ? (
          <ToolDetailReveal>
            {items.length === 1 ? (
              <ToolCardBody item={items[0]!} />
            ) : (
              <div className="mt-0.5 ml-2 flex flex-col gap-0.5 border-l border-[var(--border)] pl-2.5">
                {items.map((item) => (
                  <ToolTrowRow key={item.toolUseId} item={item} />
                ))}
              </div>
            )}
          </ToolDetailReveal>
        )
        : null}
    </AstryxCollapsible>
  );
}

function ToolTrowRow({ item }: { item: ToolActivityItem }) {
  const locale = useUiLocale();
  const presentation = deriveToolActivityPresentation(item, locale);
  const disclosure = useToolDisclosure(presentation);
  const duration = formatDuration(item.durationMs);
  const running = isToolRowRunning(item.status);
  const settled = isToolRowSettled(item.status);
  const sandboxBlocked = isSandboxDeniedTool(item);
  const errored = item.status === 'errored' && !sandboxBlocked;
  const summaryTone = errored
    ? 'text-[color:var(--destructive)]'
    : sandboxBlocked
      ? 'text-[color:var(--warning-text,var(--info-text))]'
      : 'text-[color:var(--muted-foreground)]';
  // Collapsed rows still need a word for fail/block; tint alone is not enough.
  const rowLabel = item.intent ? formatToolIntent(item.intent) : resolveToolDisplayName(item, locale);
  return (
    <AstryxCollapsible
      className="flex flex-col"
      data-trow="row"
      data-status={sandboxBlocked ? 'blocked' : item.status}
      data-settled={settled ? 'true' : undefined}
      isOpen={disclosure.open}
      onOpenChange={disclosure.setOpen}
      trigger={(
        <span className="flex min-w-0 items-center gap-[length:var(--spacing-1-5,0.375rem)] py-0.5">
          <ToolKindIcon
            kind={presentation.kind}
            size={16}
            aria-hidden="true"
            className={cn('shrink-0', summaryTone)}
          />
          {running ? (
            <TextShimmer active delayed className="min-w-0 truncate text-[length:var(--text-supporting-size)] font-medium">{presentation.summary}</TextShimmer>
          ) : (
            <span className={cn('min-w-0 truncate text-[length:var(--text-supporting-size)] font-medium', summaryTone)}>
              {errored
                ? `${rowLabel} · ${getToolActivityCopy(locale).group.failedSuffix}`
                : sandboxBlocked
                  ? `${rowLabel} · ${getToolActivityCopy(locale).group.sandboxBlockedSuffix}`
                  : rowLabel}
            </span>
          )}
          {duration && (
            <span className="shrink-0 text-[length:var(--text-supporting-size)] text-[color:var(--muted-foreground)] [font-variant-numeric:tabular-nums]">
              {duration}
            </span>
          )}
        </span>
      )}
    >
      {disclosure.open ? (
        <ToolDetailReveal>
          <ToolCardBody item={item} />
        </ToolDetailReveal>
      ) : null}
    </AstryxCollapsible>
  );
}

function ToolOutputStream(props: {
  chunks: ToolOutputChunk[];
  live: boolean;
  truncated: boolean;
}) {
  const copy = getToolActivityCopy(useUiLocale()).output;
  const preRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!props.live) return;
    const el = preRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [props.chunks, props.live]);

  return (
    <>
      <pre ref={preRef} className={TOOL_OUTPUT_BODY_CLASS} data-live={props.live ? 'true' : undefined}>
        {props.chunks.map((chunk) => (
          <span
            key={chunk.seq}
            className={cn(
              'contents',
              chunk.stream === 'stderr' && 'text-[color:var(--destructive)]',
              chunk.redacted && 'opacity-[0.65]',
            )}
            data-stream={chunk.stream}
            data-redacted={chunk.redacted ? 'true' : undefined}
          >
            {chunk.text}
            {chunk.redacted && (
              <span className="inline ml-0.5 text-[color:var(--warning-text,var(--info-text))]" aria-label={copy.redactedAriaLabel}>
                {' '}{copy.redacted}
              </span>
            )}
          </span>
        ))}
      </pre>
      {props.truncated && (
        <p className={TOOL_OUTPUT_NOTE_CLASS}>{copy.truncated}</p>
      )}
    </>
  );
}

/** Warning banner only for sandbox denials; ordinary failures use row status + wells. */
function SandboxBlockedBanner(props: {
  result: ToolActivityItem['result'];
}) {
  const locale = useUiLocale();
  const copyText = getToolActivityCopy(locale);
  const bannerCopy = copyText.sandboxBlocked;
  // UI-level mask before display and copy (main-side redaction can miss paths).
  const errorText = formatUserVisibleToolText(redactSecrets(extractErrorText(props.result, locale)), locale);
  const copyFeedback = useClipboardCopyFeedback();
  const copyPhase = copyFeedback.phaseFor('tool-error');
  const copyPending = copyPhase === 'pending';
  const copyLabel = copyPhase === 'pending'
    ? copyText.copy.pending
    : copyPhase === 'copied'
      ? copyText.copy.copied
      : copyPhase === 'failed'
        ? copyText.copy.failed
        : copyText.copy.idle;

  async function copy() {
    if (!errorText) return;
    await copyFeedback.copy('tool-error', errorText);
  }

  return (
    <Banner
      status="warning"
      className="mb-2.5"
      icon={<ShieldAlert size={16} aria-hidden="true" />}
      title={bannerCopy.title}
      description={(
        <span className="flex flex-col gap-1 text-xs leading-normal whitespace-pre-wrap [word-break:break-word]">
          <span>{bannerCopy.description}</span>
          {errorText && (
            <span className="[font-family:var(--font-mono)]">
              {summarizeErrorText(errorText)}
            </span>
          )}
        </span>
      )}
      endContent={errorText ? (
        <UiButton
          variant="ghost"
          size="sm"
          className="[align-self:start] data-[pending=true]:cursor-progress data-[copy-feedback=copied]:text-[color:var(--link)] data-[copy-feedback=copied]:border-[oklch(from_var(--link)_l_c_h_/_0.35)] data-[copy-feedback=failed]:text-[color:var(--destructive)] data-[copy-feedback=failed]:border-[oklch(from_var(--destructive)_l_c_h_/_0.35)]"
          data-pending={copyPending ? 'true' : undefined}
          data-copy-feedback={copyPhase ?? undefined}
          aria-label={bannerCopy.copyAriaLabel(copyLabel)}
          aria-busy={copyPending ? 'true' : undefined}
          isDisabled={copyPending}
          onClick={() => void copy()}
          icon={copyPhase === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          label={copyLabel}
        />
      ) : undefined}
    />
  );
}

export { formatBytes } from './tool-activity/preview-utils.js';
