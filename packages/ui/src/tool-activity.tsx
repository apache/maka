/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { useEffect, useRef } from 'react';
import { countDiffLineStats } from '@maka/core/unified-diff';
import { isInFlightToolStatus } from '@maka/core/tool-result-status';
import { type ToolResultContent } from '@maka/core/events';
import { type UiLocale } from '@maka/core/ui-locale';
import {
  ICON_SIZE,
  Check,
  ChevronRight,
  Copy,
  ShieldAlert,
} from './icons.js';
import { useClipboardCopyFeedback } from './clipboard-feedback.js';
import { useUiLocale } from './locale-context.js';
import { type ToolActivityItem, type ToolOutputChunk } from './materialize.js';
import { isConnectorTool, resolveToolDisplayName } from './tool-activity/display-name.js';
import { computerActionLabel } from './tool-activity/computer-action-label.js';
import {
  extractErrorText,
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
  List,
  ListItem,
  StatusDot,
  Text,
  type ChatToolCallItem,
  VisuallyHidden,
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
import { dotForStatus, type StatusSemantic } from './status-vocabulary.js';

/** Friendly card for a `load_tools` result; falls back to JSON on unexpected shapes. */
function LoadToolResultPreview(props: {
  args: unknown;
  value: unknown;
  actionIdentity: string;
}) {
  const locale = useUiLocale();
  const desc = describeLoadToolResult(props.args, props.value, locale);
  if (!desc) {
    return (
      <ToolResultPreview
        content={{ kind: 'json', value: props.value }}
        actionIdentity={props.actionIdentity}
      />
    );
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

/**
 * What a tool row reveals when expanded: the sandbox banner, the invocation,
 * live output or the settled result preview. Exported because Astryx owns the
 * row's expansion state internally — this panel is the seam where the product
 * decides what a result looks like, and it is asserted directly.
 */
export function ToolCallDetail({
  item,
}: {
  item: ToolActivityItem;
}) {
  const locale = useUiLocale();
  const cancelled = isCancelledToolResult(item.result);
  const sandboxBlocked = isSandboxDeniedTool(item);
  // Cancel is not a failure; stale errored+cancelled must not paint as failed.
  const failedOutcome = item.status === 'errored' && !cancelled;
  const permissionDenied = isPermissionDeniedToolResult(item.result);
  const running = isInFlightToolStatus(item.status);
  const outputActionIdentity = [
    computerActionLabel(item, locale) ?? resolveToolDisplayName(item, locale),
    item.intent ? formatToolIntent(item.intent) : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ');
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
          <LoadToolResultPreview
            args={item.args}
            value={displayResult.value}
            actionIdentity={outputActionIdentity}
          />
        ) : (
          <ToolResultPreview
            content={displayResult}
            toolName={item.toolName}
            args={item.args}
            shellRunSource={item.shellRunSource}
            actionIdentity={outputActionIdentity}
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
          actionIdentity={outputActionIdentity}
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
                  actionIdentity={outputActionIdentity}
                />
              );
            }
            if (showInvocation && invocationLine && !showResult) {
              return <ToolCodeBlock code={invocationLine} actionIdentity={outputActionIdentity} />;
            }
            if (showResult && !ownsPanel && displayResult) {
              return (
                <ToolResultPreview
                  content={displayResult}
                  toolName={item.toolName}
                  actionIdentity={outputActionIdentity}
                />
              );
            }
            if (showInvocation && invocationLine) {
              return <ToolCodeBlock code={invocationLine} actionIdentity={outputActionIdentity} />;
            }
            return null;
          })()}
        </div>
      )}
    </div>
  );
}

/**
 * Ordinary tool evidence renders through Astryx `ChatToolCalls`; linked child
 * sessions render through Astryx `ListItem` because their primary action is
 * navigation, not inline evidence expansion. Adjacent segments preserve the
 * source order without restoring a vendor activation patch.
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
  const segments = toolTrowSegments(items, locale);

  // ChatToolCalls owns expandable tool evidence. Linked child sessions are
  // navigation targets instead, so they render through Astryx's compact List:
  // one native clickable row, with no parallel action button.
  return (
    <>
      {segments.map((segment) => segment.kind === 'tools' ? (
        <ChatToolCalls
          key={segment.key}
          className="maka-tool-activity-card"
          calls={segment.calls}
        />
      ) : (
        <LinkedAgentList
          key={segment.key}
          rows={segment.rows}
          locale={locale}
          onOpenLinkedSession={onOpenLinkedSession}
        />
      ))}
    </>
  );
}

/** Whether a visible, collapsed ChatToolCalls row owns the active spinner. */
export function toolTrowHasVisibleSpinner(items: readonly ToolActivityItem[]): boolean {
  return items.some((item, index) =>
    !isLinkedAgentResult(item.result)
    && isInFlightToolStatus(item.status)
    && (index === items.length - 1 || isLinkedAgentResult(items[index + 1]?.result)),
  );
}

type LinkedAgentRow = {
  key: string;
  name: string;
  status: Extract<ToolResultContent, { kind: 'subagent' }>['status'];
  readOnly: boolean;
  target?: string;
  duration?: string;
  failureClass?: string;
  childSessionId?: string;
};

type ToolTrowSegment =
  | { kind: 'tools'; key: string; calls: ChatToolCallItem[] }
  | { kind: 'agents'; key: string; rows: LinkedAgentRow[] };

function toolTrowSegments(items: ToolActivityItem[], locale: UiLocale): ToolTrowSegment[] {
  const segments: ToolTrowSegment[] = [];
  for (const item of items) {
    const rows = linkedAgentRows(item, locale);
    const previous = segments.at(-1);
    if (rows) {
      if (previous?.kind === 'agents') previous.rows.push(...rows);
      else segments.push({ kind: 'agents', key: item.toolUseId, rows });
      continue;
    }
    const call = standardToolCall(item, locale);
    if (previous?.kind === 'tools') previous.calls.push(call);
    else segments.push({ kind: 'tools', key: item.toolUseId, calls: [call] });
  }
  return segments;
}

function LinkedAgentList(props: {
  rows: LinkedAgentRow[];
  locale: UiLocale;
  onOpenLinkedSession?: (sessionId: string) => void;
}) {
  const copy = getToolActivityCopy(props.locale).agent;
  return (
    <List density="compact">
      {props.rows.map((row) => {
        const childSessionId = row.childSessionId;
        const open = childSessionId && props.onOpenLinkedSession
          ? () => props.onOpenLinkedSession?.(childSessionId)
          : undefined;
        const status = copy.subagentStatus[row.status];
        return (
          <ListItem
            key={row.key}
            startContent={(
              <StatusDot
                variant={dotForStatus(linkedAgentStatusSemantic(row.status))}
                label={status}
                isPulsing={row.status === 'running'}
              />
            )}
            label={(
              <span className="maka-subagent-session-label">
                <Text type="label" maxLines={1}>
                  {row.name}
                </Text>
                {row.target ? (
                  <Text type="body" color="secondary" maxLines={1} className="maka-subagent-session-summary">
                    {row.target}
                  </Text>
                ) : null}
                {row.failureClass ? (
                  <VisuallyHidden>Error: {row.failureClass}</VisuallyHidden>
                ) : null}
              </span>
            )}
            endContent={(
              <span className="maka-subagent-session-end">
                <Text type="supporting" color="secondary">
                  {[subagentStats(row.status, row.readOnly, props.locale), row.duration]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
                {open ? <ChevronRight size={ICON_SIZE.meta} aria-hidden="true" /> : null}
              </span>
            )}
            onClick={open}
          />
        );
      })}
    </List>
  );
}

function standardToolCall(item: ToolActivityItem, locale: UiLocale): ChatToolCallItem {
  return {
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
        <ToolCallDetail item={item} />
      </ToolDetailReveal>
    ),
  };
}

function linkedAgentRows(
  item: ToolActivityItem,
  locale: UiLocale,
): LinkedAgentRow[] | undefined {
  const result = item.result;
  if (!isLinkedAgentResult(result)) return undefined;
  if (result?.kind === 'subagent') {
    const name = redactSecrets(result.agentName.trim()) || resolveToolDisplayName(item, locale);
    return [{
      key: item.toolUseId,
      name,
      status: result.status,
      readOnly: result.permissionMode === 'explore',
      target: item.intent
        ? formatToolIntent(item.intent)
        : boundedAgentSummary(result.summary),
      duration: formatDuration(item.durationMs ?? result.durationMs) ?? undefined,
      failureClass: result.failureClass ? redactSecrets(result.failureClass) : undefined,
      childSessionId: result.childSessionId,
    }];
  }
  return result.items.map((child) => {
    const name = redactSecrets((child.agentName || child.itemId).trim()) || child.profile;
    return {
      key: `${item.toolUseId}:${child.itemId}`,
      name,
      status: child.status,
      readOnly: child.profile === 'local_read',
      target: boundedAgentSummary(child.summary),
      duration: formatDuration(child.durationMs) ?? undefined,
      failureClass: child.failureClass ? redactSecrets(child.failureClass) : undefined,
      childSessionId: child.childSessionId,
    } satisfies LinkedAgentRow;
  });
}

function isLinkedAgentResult(
  result: ToolActivityItem['result'],
): result is Extract<ToolResultContent, { kind: 'subagent' | 'agent_swarm' }> {
  return result?.kind === 'subagent'
    || (result?.kind === 'agent_swarm' && result.items.length > 0);
}

type LinkedAgentStatus = Extract<ToolResultContent, { kind: 'subagent' }>['status'];

const LINKED_AGENT_STATUS_SEMANTIC = {
  completed: 'success',
  running: 'active',
  waiting_for_user: 'attention',
  failed: 'error',
  cancelled: 'neutral',
} satisfies Record<LinkedAgentStatus, StatusSemantic>;

function linkedAgentStatusSemantic(status: LinkedAgentStatus): StatusSemantic {
  return LINKED_AGENT_STATUS_SEMANTIC[status];
}

function subagentStats(
  status: Extract<ToolResultContent, { kind: 'subagent' }>['status'],
  readOnly: boolean,
  locale: UiLocale,
): string {
  const copy = getToolActivityCopy(locale).agent;
  return [copy.subagentStatus[status], readOnly ? copy.readOnly : undefined]
    .filter(Boolean)
    .join(' · ');
}

function boundedAgentSummary(summary: string): string | undefined {
  const normalized = redactSecrets(summary.trim());
  if (!normalized) return undefined;
  return normalized.length <= 280 ? normalized : `${normalized.slice(0, 279)}…`;
}

/**
 * Green `+N` / red `-N`, from the shared structural parse. Each visible call
 * owns its diff counts. Zero stays unpainted so unchanged calls do not wear a
 * misleading "0 changes" badge.
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
      icon={<ShieldAlert size={ICON_SIZE.chrome} aria-hidden="true" />}
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
          icon={copyPhase === 'copied' ? <Check size={ICON_SIZE.control} aria-hidden="true" /> : <Copy size={ICON_SIZE.control} aria-hidden="true" />}
          label={copyLabel}
        />
      ) : undefined}
    />
  );
}

export { formatBytes } from './tool-activity/preview-utils.js';
