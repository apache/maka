import { useEffect, useRef, type ComponentType } from 'react';
import {
  countDiffLineStats,
  isInFlightToolStatus,
  type ToolResultContent,
  type UiLocale,
} from '@maka/core';
import {
  Check,
  Clock,
  Copy,
  Repeat,
  ShieldAlert,
  type LucideProps,
} from './icons.js';
import { useClipboardCopyFeedback } from './clipboard-feedback.js';
import { useUiLocale } from './locale-context.js';
import { type ToolActivityItem, type ToolOutputChunk } from './materialize.js';
import { isConnectorTool, resolveToolDisplayName } from './tool-activity/display-name.js';
import { computerActionLabel } from './tool-activity/computer-action-label.js';
import {
  extractErrorText,
  isAutomationTool,
  isCancelledToolResult,
  isPermissionDeniedToolResult,
  resultOwnsOwnPanel,
  withLiveStreamFallback,
} from './tool-activity/result-projection.js';
import { isSandboxDeniedTool } from './tool-activity/sandbox-denial.js';
import { previewVariants } from './primitives/chat.js';
import { redactSecrets } from './redact.js';
import {
  Button as UiButton,
  Banner,
  ChatToolCalls,
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
  TOOL_OUTPUT_NOTE_CLASS,
  ToolOutputSurface,
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

const AUTOMATION_RESULT_ICON_CLASS = 'maka-automation-result-icon';

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

/**
 * What a tool row reveals when expanded: the sandbox banner, the invocation,
 * live output or the settled result preview. Exported because Astryx owns the
 * row's expansion state internally — this panel is the seam where the product
 * decides what a result looks like, and it is asserted directly.
 */
export function ToolCallDetail({
  item,
  onOpenLinkedSession,
}: {
  item: ToolActivityItem;
  onOpenLinkedSession?(sessionId: string): void;
}) {
  const locale = useUiLocale();
  const cancelled = isCancelledToolResult(item.result);
  const sandboxBlocked = isSandboxDeniedTool(item);
  // Cancel is not a failure; stale errored+cancelled must not paint as failed.
  const failedOutcome = item.status === 'errored' && !cancelled;
  const permissionDenied = isPermissionDeniedToolResult(item.result);
  const running = isInFlightToolStatus(item.status);
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
  // Live streaming has its own surface below, so this covers only the settled
  // stack.
  const hasSharedPanelContent =
    !ownsPanel && !showLiveStream && (
      showInvocation
      || !!resultHeadline
      || showResult
      || (!!item.args && !permissionDenied && !invocationLine)
    );

  return (
    <div className="maka-tool-call-detail">
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
            onOpenLinkedSession={onOpenLinkedSession}
          />
        )
      )}
      {/* Streaming uses the same surface the settled result will land in, so a
          command does not change shape the moment it finishes. It used to be a
          CodeBlock card for the command with the stream as loose text beside
          it. */}
      {showLiveStream && (
        <ToolOutputSurface
          kind="live_stream"
          heading={showInvocation ? invocationLine : undefined}
        >
          <ToolOutputStream
            chunks={item.outputChunks!}
            live={running}
            truncated={item.outputTruncated === true}
          />
        </ToolOutputSurface>
      )}
      {hasSharedPanelContent && (
        <div data-slot="tool-output" className="maka-tool-output-stack">
          {(() => {
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
              return (
                <ToolResultPreview
                  content={displayResult}
                  toolName={item.toolName}
                  onOpenLinkedSession={onOpenLinkedSession}
                />
              );
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

/**
 * Every tool row renders through Astryx `ChatToolCalls` — one component, one
 * visual language, whatever the status. The six product statuses fold into
 * Astryx's four: `interrupted` and sandbox denials are failures that carry
 * their own word in `errorMessage`, and the detail panel (banner, command,
 * output, previews) rides along in `resultDetail`.
 */
export function ToolTrow({
  items,
  onOpenLinkedSession,
}: {
  items: ToolActivityItem[];
  onOpenLinkedSession?(sessionId: string): void;
}) {
  const locale = useUiLocale();
  if (items.length === 0) return null;
  const calls: ChatToolCallItem[] = items.map((item) => ({
    key: item.toolUseId,
    // The name is what a person reads to tell one call from the next, and for
    // Computer Use the display name is "Maka Computer" — a noun, identical on
    // every row of a ten-call turn. A label derived from the call's own
    // arguments says what happened instead.
    name: computerActionLabel(item, locale) ?? resolveToolDisplayName(item, locale),
    status: astryxToolStatus(item),
    target: item.intent ? formatToolIntent(item.intent) : undefined,
    duration: formatDuration(item.durationMs) ?? undefined,
    errorMessage: toolCallErrorMessage(item, locale),
    stats: outcomeWord(item, locale),
    ...diffStats(itemDiffs(item)),
    resultDetail: (
      <ToolDetailReveal>
        <ToolCallDetail item={item} onOpenLinkedSession={onOpenLinkedSession} />
      </ToolDetailReveal>
    ),
  }));

  // No defaultIsExpanded: opening a group is the reader's move. Seeding it open
  // from in-flight status latches, since the prop is uncontrolled and the
  // timeline key is stable (see timelineEntryKey). Cost: the collapsed header
  // projects the last call, which can settle before a parallel sibling.
  //
  // A group's own +/- is the whole turn's, not the last call's: a run of five
  // Edits collapses to one line, and "what did this turn change" is the
  // question that line has to answer. Per-call counts stay on the rows inside.
  return <ChatToolCalls calls={calls} {...diffStats(items.flatMap(itemDiffs))} />;
}

/**
 * Green `+N` / red `-N`, from the shared structural parse. One diff for a row,
 * every diff in the run for the collapsed group header. Zero stays unpainted,
 * so a run that changed no file leaves the header as it was rather than
 * wearing a "0 changes" badge.
 */
function diffStats(diffs: string[]): { additions?: number; deletions?: number } {
  let additions = 0;
  let deletions = 0;
  for (const diff of diffs) {
    const stats = countDiffLineStats(diff);
    additions += stats.additions;
    deletions += stats.deletions;
  }
  return {
    ...(additions > 0 ? { additions } : {}),
    ...(deletions > 0 ? { deletions } : {}),
  };
}

/** The diff a tool call produced, if it produced one. */
function itemDiffs(item: ToolActivityItem): string[] {
  return item.result?.kind === 'file_diff' ? [item.result.diff] : [];
}

function astryxToolStatus(item: ToolActivityItem): ChatToolCallItem['status'] {
  switch (item.status) {
    case 'completed': return 'complete';
    case 'errored':
    case 'interrupted': return 'error';
    case 'running': return 'running';
    default: return 'pending';
  }
}

/**
 * Full failure text. Astryx hangs it off the status icon of an expanded row
 * and reads it out there; its collapsed group header carries neither this nor
 * `stats`, so in a settled group the text is reachable only once expanded.
 * `interrupted` says its piece through `stats` instead — routing it here too
 * would make a screen reader announce the same word twice.
 */
function toolCallErrorMessage(item: ToolActivityItem, locale: UiLocale): string | undefined {
  if (item.status !== 'errored') return undefined;
  return summarizeErrorText(formatUserVisibleToolText(
    redactSecrets(extractErrorText(item.result, locale)),
    locale,
  )).replace(/^Error:\s*/i, '');
}

/**
 * A visible word for the two outcomes a red status icon cannot say on its own:
 * the run stopped before finishing, or the sandbox likely blocked it. Ordinary
 * failures keep Astryx's own treatment — the error text is one click away in
 * the detail panel.
 */
function outcomeWord(item: ToolActivityItem, locale: UiLocale): string | undefined {
  const copy = getToolActivityCopy(locale).status;
  if (item.status === 'interrupted') return copy.interrupted;
  if (item.status === 'errored' && isSandboxDeniedTool(item)) return copy.sandboxBlocked;
  return undefined;
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
              'maka-tool-output-chunk',
              chunk.stream === 'stderr' && 'maka-tool-output-chunk-stderr',
              chunk.redacted && 'maka-tool-output-chunk-redacted',
            )}
            data-stream={chunk.stream}
            data-redacted={chunk.redacted ? 'true' : undefined}
          >
            {chunk.text}
            {chunk.redacted && (
              <span className="maka-tool-output-redacted">
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
      className="maka-sandbox-blocked-banner"
      icon={<ShieldAlert size={16} aria-hidden="true" />}
      title={bannerCopy.title}
      description={(
        <span className="maka-sandbox-blocked-description">
          <span>{bannerCopy.description}</span>
          {errorText && (
            <code className="maka-sandbox-blocked-error">
              {summarizeErrorText(errorText)}
            </code>
          )}
        </span>
      )}
      endContent={errorText ? (
        <UiButton
          variant="ghost"
          size="sm"
          className="maka-sandbox-blocked-copy"
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
