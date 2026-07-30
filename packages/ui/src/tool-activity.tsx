import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import type { ToolResultContent } from '@maka/core';
import {
  AlertOctagon,
  Check,
  ChevronRight,
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
  X,
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
import { Alert, AlertAction, AlertDescription, AlertTitle } from './primitives/alert.js';
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from './primitives/collapsible.js';
import { previewVariants, TextShimmer, toolVariants } from './primitives/chat.js';
import { redactSecrets } from './redact.js';
import { Button as UiButton, cn } from './ui.js';
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
  // Ordinary work stays summarized. A new permission prompt opens the
  // diagnostics (it is actionable); an errored tool stays collapsed — the
  // failure signal lives on the summary line. An explicit user toggle survives
  // later ordinary status changes. See disclosure-collapsible-contract:
  // defaultOpen is banned here.
  const presentation = deriveToolActivityPresentation(item, locale);
  const disclosure = useToolDisclosure(presentation);
  const open = openProp ?? disclosure.open;
  const duration = formatDuration(item.durationMs);
  const visualStatus = isSandboxDeniedTool(item) ? 'blocked' : item.status;
  return (
    <Collapsible
      data-slot="tool"
      className={toolVariants({ part: 'item' })}
      data-status={visualStatus}
      open={open}
      onOpenChange={disclosure.setOpen}
    >
      <CollapsibleTrigger className={toolVariants({ part: 'header' })}>
        <span className={toolVariants({ part: 'dot' })} data-status={visualStatus} aria-hidden="true" />
        <span className={toolVariants({ part: 'name' })}>{resolveToolDisplayName(item, locale)}</span>
        <span className={toolVariants({ part: 'meta' })}>
          {duration && <span className={toolVariants({ part: 'duration' })}>{duration}</span>}
          <span className={toolVariants({ part: 'status-label' })}>{toolStatusLabel(item, locale)}</span>
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ToolCardBody item={item} />
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * The tool detail body — error banner + one Codex-like output well for
 * command/args, live stream, and structured results. Shared by the boxed
 * `ToolActivityCard` and flat trow rows. Args/results route through
 * quiet formatters (tool-args-redaction-contract / quiet-panel contracts).
 */
function ToolCardBody({ item }: { item: ToolActivityItem }) {
  const locale = useUiLocale();
  const cancelled = isCancelledToolResult(item.result);
  const sandboxBlocked = isSandboxDeniedTool(item);
  // Cancel maps to interrupted at materialize/live-projection; keep defensive
  // checks so a stale errored+cancelled item still does not look like failure.
  const failedOutcome = item.status === 'errored' && !cancelled;
  const errored = failedOutcome && !sandboxBlocked;
  const permissionDenied = isPermissionDeniedToolResult(item.result);
  const running = item.status === 'running' || item.status === 'pending';
  const ptyControlResult = item.toolName === 'WriteStdin' && item.result?.kind === 'shell_run';
  // Rich kinds + tool-specific cards own their chrome — never nest in the shared well.
  const ownsPanel = resultOwnsOwnPanel(item);
  const showErrorBanner = failedOutcome && !ptyControlResult;
  // Every tool: human invocation line from args — never pretty-printed JSON.
  // Skip when the result panel already prints the command (terminal/shell_run).
  const invocationLine = !permissionDenied && !ownsPanel
    ? formatToolInvocationLine(item, locale)
    : undefined;
  // While running the live stream is the output; once a structured result
  // preview exists it is the single quiet output block — never render both.
  // Owned terminal/shell_run panels absorb an empty-body handoff via
  // withLiveStreamFallback (never a second live panel).
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
  // Keep the invocation line whenever args yield one. Only add a result
  // headline when it says something different (avoids dropping Write/Edit paths
  // when path === path).
  const showInvocation = invocationLine !== undefined;
  const resultHeadline = quietJson?.headline
    && quietJson.headline !== invocationLine
    ? quietJson.headline
    : undefined;
  // Owned-panel kinds render alone. Everything else shares one quiet well.
  const hasSharedPanelContent =
    !ownsPanel && (
      showInvocation
      || !!resultHeadline
      || showLiveStream
      || (showResult && !failedOutcome)
      || (!!item.args && !permissionDenied && !invocationLine && !showResult && !showLiveStream)
    );

  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {showErrorBanner && (
        <ToolErrorBanner
          result={displayResult ?? item.result}
          sandboxBlocked={sandboxBlocked}
        />
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
        <div
          data-slot="tool-output"
          className={cn(
            TOOL_OUTPUT_PANEL_CLASS,
            errored && 'border-[oklch(from_var(--destructive)_l_c_h_/_0.28)]',
            sandboxBlocked && 'border-[oklch(from_var(--warning)_l_c_h_/_0.32)]',
          )}
        >
          {showInvocation && (
            <code className={TOOL_OUTPUT_COMMAND_CLASS}>{invocationLine}</code>
          )}
          {resultHeadline && (
            <code className={TOOL_OUTPUT_COMMAND_CLASS}>{resultHeadline}</code>
          )}
          {/* No formatRedactedJson dump — if invocation failed, quiet-format args. */}
          {!showInvocation && !resultHeadline && item.args !== undefined && !permissionDenied && !showResult && (
            <pre className={cn(TOOL_OUTPUT_BODY_CLASS, 'max-h-40')}>
              {formatQuietJsonValue(item.args, locale).body}
            </pre>
          )}
          {showLiveStream && (
            <ToolOutputStream
              chunks={item.outputChunks!}
              live={running}
              truncated={item.outputTruncated === true}
            />
          )}
          {showResult && !ownsPanel && displayResult && !errored && (
            quietJson ? (
              <pre className={TOOL_OUTPUT_BODY_CLASS}>{quietJson.body}</pre>
            ) : (
              <ToolResultPreview content={displayResult} toolName={item.toolName} />
            )
          )}
        </div>
      )}
      {errored && showResult && displayResult && !ownsPanel && (
        <ToolErrorDetails>
          {quietJson ? (
            <pre className={TOOL_OUTPUT_BODY_CLASS}>{quietJson.body}</pre>
          ) : (
            <ToolResultPreview content={displayResult} />
          )}
        </ToolErrorDetails>
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

// #646 run→done seam: the one-shot settle "landing" for the group summary line.
// Reuses the whitelisted `maka-stream-fade-in` keyframe (opacity 0→1, one-shot
// `both`) — no new keyframe (design-406 governance) — and rides
// `var(--duration-emphasized)` / `var(--ease-out-strong)` so it converges with
// the motion tokens. Applied only when the group was seen running here and
// just settled, so a replayed transcript's summary stays static. Auto-frozen
// under reduced-motion / e2e-fixture by the global rules in styles/base.css.
// The per-row seam is a light-band stop (no opacity fade) so parallel tools
// finishing together don't stack N fades (#tool-jitter).
export const SETTLE_FADE = '[animation:maka-stream-fade-in_var(--duration-emphasized)_var(--ease-out-strong)_both]';

/**
 * Codex-style tool trow (streaming UI rework): one contiguous run of tool
 * activity rendered as a single flat, borderless disclosure — replacing the
 * boxed "工具调用 N" card stack inside a turn. The summary disclosure is the
 * stable root for both one and many tools, so a second call appends inside the
 * same component instead of replacing an expanded row with a collapsed group.
 * A parent Processing disclosure can request direct rows because it already
 * owns the group summary; this avoids rendering the same summary twice.
 */
export function ToolTrow({
  items,
  variant = 'group',
}: {
  items: ToolActivityItem[];
  variant?: 'group' | 'rows';
}) {
  if (items.length === 0) return null;
  if (variant === 'rows') {
    return items.map((item) => <ToolTrowRow key={item.toolUseId} item={item} />);
  }
  return <ToolTrowGroup items={items} />;
}

function ToolTrowGroup({ items }: { items: ToolActivityItem[] }) {
  const locale = useUiLocale();
  const running = isTrowRunning(items);
  const attention = trowNeedsAttention(items);
  // The group's presentation follows the first item (the first-seen bucket the
  // summary clauses and icon use). The active-tool lookup is gone: a multi-tool
  // running group shows the whole-group aggregation, a single-tool group's
  // active tool is items[0] anyway, and disclosure attention is overridden by
  // the whole-group trowNeedsAttention below.
  const firstPresentation = deriveToolActivityPresentation(items[0]!, locale);
  // Groups share the same disclosure state as a single row: ordinary work is
  // summarized; a new permission prompt opens diagnostics (errors stay
  // collapsed — the summary line carries the failure signal); manual choice
  // survives ordinary status changes.
  const disclosure = useToolDisclosure({ ...firstPresentation, needsAttention: attention });
  // #646: a group settles when all its tools do; the settle fade plays only if
  // the group was ever seen running here (not a replayed transcript). The
  // delayed shimmer de-flickers a group whose tools all finish sub-second.
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
  // #tool-jitter: the group icon stays on the first bucket's kind (the same
  // first-seen order the summary clauses use), not the active tool's kind — so
  // a mixed-kind group's icon doesn't flip as the active tool changes mid-run.
  // Multi-tool running group shows the whole-group bucket aggregation with a
  // "正在" prefix instead of the active tool's description, so the summary line
  // stops cycling through each tool's intent as tools start/finish in
  // parallel (the 1234567 jitter). Single-tool rows keep the tool's own
  // description — the "what exactly is running" signal is useful when there is
  // only one, and it is locked by existing tests.
  const summary = running
    ? (items.length > 1 ? summarizeTrowTools(items, { live: true, locale }) : firstPresentation.summary)
    : summarizeTrowTools(items, { locale });
  return (
    <Collapsible className="flex flex-col" data-trow="group" data-settled={settled ? 'true' : undefined} open={disclosure.open} onOpenChange={disclosure.setOpen}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 py-0.5 text-left">
        <ToolKindIcon kind={firstPresentation.kind} size={16} aria-hidden="true" className={cn('shrink-0', settledTone)} />
        {running ? (
          <TextShimmer active delayed className="min-w-0 truncate text-[length:var(--font-size-base)]">{summary}</TextShimmer>
        ) : (
          <span className={cn('min-w-0 truncate text-[length:var(--font-size-base)]', settledTone, settling && SETTLE_FADE)}>{summary}</span>
        )}
        <ChevronRight
          size={14}
          aria-hidden="true"
          className="shrink-0 text-[color:var(--muted-foreground)] opacity-0 [transition:transform_var(--duration-quick)_var(--ease-out-strong),opacity_var(--duration-quick)_var(--ease-out-strong)] group-hover:opacity-100 group-data-[panel-open]:rotate-90 group-data-[panel-open]:opacity-100"
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        {items.length === 1 ? (
          <ToolCardBody item={items[0]!} />
        ) : (
          <div className="mt-0.5 ml-2 flex flex-col gap-0.5 border-l border-[var(--border)] pl-2.5">
            {items.map((item) => (
              <ToolTrowRow key={item.toolUseId} item={item} />
            ))}
          </div>
        )}
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * A single flat, borderless tool row inside a multi-tool trow. Ordinary work
 * is collapsed; permission prompts open for attention (errors stay collapsed —
 * the summary line carries the failure signal), and a user's manual choice
 * survives later ordinary status changes. No card frame
 * (`toolVariants({item})`), per the flat trow visual language.
 */
function ToolTrowRow({ item }: { item: ToolActivityItem }) {
  const locale = useUiLocale();
  const presentation = deriveToolActivityPresentation(item, locale);
  const disclosure = useToolDisclosure(presentation);
  const duration = formatDuration(item.durationMs);
  // #tool-jitter: a row settles by its shimmer stopping — the same seam as the
  // 深度思考 disclosure title (light band → static muted text), with no opacity
  // fade. Parallel tools finishing together each just drop their light band
  // instead of stacking N opacity-0→1 fades, so a batch settle no longer 1234567.
  const running = isToolRowRunning(item.status);
  const settled = isToolRowSettled(item.status);
  const sandboxBlocked = isSandboxDeniedTool(item);
  const errored = item.status === 'errored' && !sandboxBlocked;
  // One row language with the multi-tool summary row: a kind icon + a
  // user-language phrase, never the old status-dot + mono tool-name + status
  // word. Running shimmers the model's intent (or the friendly tool name);
  // settled prefers the intent, falls back to the display name.
  const summaryTone = errored
    ? 'text-[color:var(--destructive)]'
    : sandboxBlocked
      ? 'text-[color:var(--warning-text,var(--info-text))]'
      : 'text-[color:var(--muted-foreground)]';
  // Settled attention states stay collapsed, so tint alone is not enough:
  // spell out whether the operation failed or the sandbox blocked it.
  const rowLabel = item.intent ? formatToolIntent(item.intent) : resolveToolDisplayName(item, locale);
  return (
    <Collapsible className="flex flex-col" data-trow="row" data-status={sandboxBlocked ? 'blocked' : item.status} data-settled={settled ? 'true' : undefined} open={disclosure.open} onOpenChange={disclosure.setOpen}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 py-0.5 text-left">
        <ToolKindIcon
          kind={presentation.kind}
          size={16}
          aria-hidden="true"
          className={cn('shrink-0', summaryTone)}
        />
        {running ? (
          <TextShimmer active delayed className="min-w-0 truncate text-[length:var(--font-size-base)]">{presentation.summary}</TextShimmer>
        ) : (
          <span className={cn('min-w-0 truncate text-[length:var(--font-size-base)]', summaryTone)}>
            {errored
              ? `${rowLabel} · ${getToolActivityCopy(locale).group.failedSuffix}`
              : sandboxBlocked
                ? `${rowLabel} · ${getToolActivityCopy(locale).group.sandboxBlockedSuffix}`
                : rowLabel}
          </span>
        )}
        {/* Quiet meta sits right after the label (near the text, not pinned to
            the far edge): duration + chevron ride in on hover / open, matching
            the multi-tool summary row — status is carried by the shimmer /
            destructive tint, so no always-on status word. */}
        <span className="inline-flex shrink-0 items-center gap-2 text-[length:var(--font-size-caption)] text-[color:var(--muted-foreground)] opacity-0 [transition:opacity_var(--duration-quick)_var(--ease-out-strong)] group-hover:opacity-100 group-data-[panel-open]:opacity-100">
          {duration && <span className="[font-variant-numeric:tabular-nums]">{duration}</span>}
          <ChevronRight
            size={14}
            aria-hidden="true"
            className="[transition:transform_var(--duration-quick)_var(--ease-out-strong)] group-data-[panel-open]:rotate-90"
          />
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ToolCardBody item={item} />
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * Live stdout/stderr body for the unified tool-output panel.
 *
 * No second card shell and no "实时输出" header — the parent panel is the
 * only chrome. Chunks keep stream tags so stderr can tint destructive.
 * Redacted chunks still surface an inline "[已脱敏]" hint. Truncation is a
 * quiet footer note, not a flag row.
 *
 * Auto-scroll: while `live` is true, anchor to the bottom on every chunk
 * update; stop once the tool settles so the user can scroll history.
 */
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

// Preserve the retired `.maka-tool-error*` leaf utilities onto Alert (#332 PR3c) —
// Alert owns the shell; these are the few declarations it doesn't set, kept arbitrary
// so they map 1:1 to the old CSS (`[align-self:start]`, not Tailwind's `flex-start`).
function ToolErrorBanner(props: {
  result: ToolActivityItem['result'];
  sandboxBlocked?: boolean;
}) {
  const locale = useUiLocale();
  const copyText = getToolActivityCopy(locale);
  const bannerCopy = props.sandboxBlocked ? copyText.sandboxBlocked : copyText.error;
  // Tool stderr / raw provider errors occasionally slip credential paths,
  // bearer tokens, or API keys through main-side redaction. Apply a
  // defensive UI-level mask before display *and* before clipboard copy so
  // the user can't accidentally paste a credential into a bug report.
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
    <Alert variant={props.sandboxBlocked ? 'warning' : 'error'} className="mb-2.5">
      {props.sandboxBlocked
        ? <ShieldAlert size={16} aria-hidden="true" />
        : <AlertOctagon size={16} aria-hidden="true" />}
      <AlertTitle>{bannerCopy.title}</AlertTitle>
      {props.sandboxBlocked ? (
        <AlertDescription className="flex flex-col gap-1 text-xs leading-normal whitespace-pre-wrap [word-break:break-word]">
          <span>{copyText.sandboxBlocked.description}</span>
          {errorText && (
            <span className="[font-family:var(--font-mono)]">
              {summarizeErrorText(errorText)}
            </span>
          )}
        </AlertDescription>
      ) : errorText ? (
        <AlertDescription className="[font-family:var(--font-mono)] text-xs leading-normal whitespace-pre-wrap [word-break:break-word]">
          {summarizeErrorText(errorText)}
        </AlertDescription>
      ) : null}
      {errorText && (
        <AlertAction>
          <UiButton
            type="button"
            variant="ghost"
            size="sm"
            className="[align-self:start] data-[pending=true]:cursor-progress data-[copy-feedback=copied]:text-[color:var(--link)] data-[copy-feedback=copied]:border-[oklch(from_var(--link)_l_c_h_/_0.35)] data-[copy-feedback=failed]:text-[color:var(--destructive)] data-[copy-feedback=failed]:border-[oklch(from_var(--destructive)_l_c_h_/_0.35)]"
            data-pending={copyPending ? 'true' : undefined}
            data-copy-feedback={copyPhase ?? undefined}
            aria-label={bannerCopy.copyAriaLabel(copyLabel)}
            aria-busy={copyPending ? 'true' : undefined}
            disabled={copyPending}
            onClick={() => void copy()}
          >
            {copyPhase === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            <span>{copyLabel}</span>
          </UiButton>
        </AlertAction>
      )}
    </Alert>
  );
}

/**
 * Raw diagnostic details for an errored tool, collapsed by default so a verbose
 * validation/runtime failure cannot dominate the conversation. The ToolErrorBanner
 * already shows the first 240px of the error text + a copy action; this disclosure
 * owns the full raw payload (quiet JSON body / structured ToolResultPreview) so it
 * is reachable but not loud. Keyboard-accessible via CollapsibleTrigger (a real
 * <button>); secret redaction + size caps stay enforced upstream (redactSecrets,
 * the banner's 240px truncation, and the result preview's own caps).
 */
export function ToolErrorDetails({ children, open: openProp, onOpenChange }: {
  children: ReactNode;
  /** Controlled open state. When omitted the disclosure manages its own state
   *  (collapsed by default). Passed by tests to render the expanded state in
   *  static markup; production callers leave it uncontrolled. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const copy = getToolActivityCopy(useUiLocale()).output;
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;
  // Always update internalOpen so an onOpenChange-only caller still sees the
  // panel toggle (the old `onOpenChange ?? setInternalOpen` left internalOpen
  // stuck closed when only the callback was passed).
  const setOpen = (next: boolean) => {
    setInternalOpen(next);
    onOpenChange?.(next);
  };
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-1">
      <CollapsibleTrigger className="flex w-fit items-center gap-1 self-start rounded-[var(--radius-control)] text-[length:var(--font-size-ui)] text-[color:var(--muted-foreground)] outline-none transition-colors hover:text-[color:var(--foreground-secondary)] focus-visible:shadow-[0_0_0_var(--focus-ring-width)_oklch(from_var(--focus-ring)_l_c_h_/_0.14)]">
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={cn('shrink-0 transition-transform duration-[var(--duration-quick)] [transition-timing-function:var(--ease-out-strong)]', open && 'rotate-90')}
        />
        <span>{open ? copy.hideRaw : copy.showRaw}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel className="mt-1">
        {children}
      </CollapsiblePanel>
    </Collapsible>
  );
}

export function OverlayHost(props: { content?: ToolResultContent; onClose(): void }) {
  const copy = getToolActivityCopy(useUiLocale()).output;
  if (!props.content) return null;
  return (
    <div className="maka-modal-backdrop overlay">
      <UiButton
        className={previewVariants({ part: 'close' })}
        type="button"
        variant="ghost"
        size="sm"
        onClick={props.onClose}
        aria-label={copy.closeAriaLabel}
      >
        <X size={14} aria-hidden="true" />
        <span>{copy.close}</span>
      </UiButton>
      <ToolResultPreview content={props.content} />
    </div>
  );
}

export { formatBytes } from './tool-activity/preview-utils.js';
