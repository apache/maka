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

import { useEffect, useRef, useState } from 'react';
import { countDiffLineStats } from '@maka/core/unified-diff';
import { isInFlightToolStatus } from '@maka/core/tool-result-status';
import { type ToolResultContent } from '@maka/core/events';
import { type UiLocale } from '@maka/core/ui-locale';
import {
  Blocks,
  ICON_SIZE,
  Check,
  ChevronRight,
  Copy,
  GitBranch,
  Globe,
  Monitor,
  Plug,
  Settings,
  ShieldAlert,
  Workflow,
  type LucideIcon,
} from './icons.js';
import { useClipboardCopyFeedback } from './clipboard-feedback.js';
import { useUiLocale } from './locale-context.js';
import {
  toolActivityPresentationStatus,
  type ToolActivityItem,
  type ToolOutputChunk,
} from './materialize.js';
import { isConnectorTool, resolveToolDisplayName, workHubControlStatus } from './tool-activity/display-name.js';
import {
  computerActionLabel,
  computerActionLabelIncludesTarget,
  computerActionTarget,
  isComputerTool,
} from './tool-activity/computer-action-label.js';
import {
  extractErrorText,
  isCancelledToolResult,
  isPermissionDeniedToolResult,
  isRequiresBypassToolResult,
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
import {
  describeLoadToolResult,
  formatToolIntent,
  type LoadToolGroupKind,
} from './tool-format.js';
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
import { MakaClientSlotOutlet } from './client-plugin-slots.js';

/** Friendly card for tool-search and historical loader results. */
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
  const Icon = loadToolGroupIcon(desc.kind);
  const copy = getToolActivityCopy(locale).loadTools;
  return (
    <div className={previewVariants({ part: 'load-tool' })} data-kind="load_tool">
      <span className="maka-load-tool-icon" aria-hidden="true">
        <Icon size={ICON_SIZE.chrome} />
      </span>
      <div className="maka-load-tool-summary">
        <p className={previewVariants({ part: 'load-tool-title' })}>{desc.title}</p>
        <p className="maka-load-tool-description">{desc.description}</p>
        <p className={previewVariants({ part: 'load-tool-count' })}>
          <span>{desc.label}</span>
          <span className="maka-load-tool-separator" aria-hidden="true" />
          <span>{desc.countLabel}</span>
        </p>
      </div>
      {(desc.groupId || desc.toolIds.length > 0) && (
        <details className="maka-load-tool-technical">
          <summary>{copy.technicalDetails}</summary>
          <dl>
            {desc.groupId && (
              <>
                <dt>{copy.groupId}</dt>
                <dd><code>{desc.groupId}</code></dd>
              </>
            )}
            {desc.toolIds.length > 0 && (
              <>
                <dt>{copy.toolIds}</dt>
                <dd><code>{desc.toolIds.join('\n')}</code></dd>
              </>
            )}
          </dl>
        </details>
      )}
    </div>
  );
}

function loadToolGroupIcon(kind: LoadToolGroupKind): LucideIcon {
  switch (kind) {
    case 'browser':
      return Globe;
    case 'computer_use':
      return Monitor;
    case 'mcp':
      return Plug;
    case 'rive':
      return Workflow;
    case 'agent':
      return GitBranch;
    case 'settings':
      return Settings;
    default:
      return Blocks;
  }
}

type DetailDecision = {
  decorations: {
    sandboxBlockedResult?: ToolResultContent;
    requiresBypass: boolean;
  };
  body:
    | {
        kind: 'live';
        chunks: ToolOutputChunk[];
        heading?: string;
        live: boolean;
        truncated: boolean;
      }
    | {
        kind: 'result';
        result: ToolResultContent;
        presentation: 'owned' | 'shared';
        toolName: string;
        args: unknown;
        shellRunSource?: 'owned' | 'unavailable';
      }
    | {
        kind: 'loadTool';
        result: Extract<ToolResultContent, { kind: 'json' }>;
        args: unknown;
      }
    | { kind: 'quietText'; body: string; title?: string }
    | { kind: 'argsOnly'; text: string }
    | { kind: 'none' };
};

function describeToolCall(
  item: ToolActivityItem,
  locale: UiLocale,
  activityObserved: boolean,
): DetailDecision {
  const cancelled = isCancelledToolResult(item.result);
  const requiresBypass = isRequiresBypassToolResult(item.result);
  const permissionDenied = isPermissionDeniedToolResult(item.result);
  const running = activityObserved && isInFlightToolStatus(toolActivityPresentationStatus(item));
  const ptyControlResult = item.toolName === 'WriteStdin' && item.result?.kind === 'shell_run';
  const loadToolResult = isConnectorTool(item.toolName) && item.result?.kind === 'json'
    ? item.result
    : undefined;
  const resultOwnsPanel = item.result?.kind === 'terminal'
    || item.result?.kind === 'shell_run'
    || item.result?.kind === 'web_search'
    || item.result?.kind === 'web_search_error'
    || item.result?.kind === 'file_diff'
    || item.result?.kind === 'rive_workflow';
  const ownsPanel = Boolean(loadToolResult || resultOwnsPanel || requiresBypass);
  const showResult = item.result !== undefined && !permissionDenied && !requiresBypass;
  const displayResult = showResult && item.result
    ? withLiveStreamFallback(item.result, item.outputChunks, {
      truncated: item.outputTruncated === true,
      locale,
    })
    : undefined;
  const invocationLine = !permissionDenied && !ownsPanel
    ? formatToolInvocationLine(item, locale)
    : undefined;
  const showLiveStream = !!item.outputChunks
    && item.outputChunks.length > 0
    && !ownsPanel
    && (running || !item.result);
  const sandboxBlocked = isSandboxDeniedTool(item);
  const failedOutcome = item.status === 'errored' && !cancelled;
  const decorations = {
    ...(sandboxBlocked && failedOutcome && !ptyControlResult
      ? { sandboxBlockedResult: displayResult ?? item.result }
      : {}),
    requiresBypass,
  };

  if (showResult && displayResult) {
    if (loadToolResult) {
      return {
        decorations,
        body: {
          kind: 'loadTool',
          result: loadToolResult,
          args: item.args,
        },
      };
    }
    if (resultOwnsPanel) {
      return {
        decorations,
        body: {
          kind: 'result',
          result: displayResult,
          presentation: 'owned',
          toolName: item.toolName,
          args: item.args,
          shellRunSource: item.shellRunSource,
        },
      };
    }
  }

  if (showLiveStream && item.outputChunks) {
    return {
      decorations,
      body: {
        kind: 'live',
        chunks: item.outputChunks,
        heading: invocationLine,
        live: running,
        truncated: item.outputTruncated === true,
      },
    };
  }

  if (!ownsPanel && displayResult?.kind === 'json') {
    const quiet = formatQuietJsonValue(displayResult.value, locale);
    // Keep structured quiet JSON raw: generic permission-text replacement
    // could rewrite a path, command, or query in the headline.
    return {
      decorations,
      body: {
        kind: 'quietText',
        body: quiet.body,
        title: quiet.headline && quiet.headline !== invocationLine
          ? quiet.headline
          : invocationLine,
      },
    };
  }

  if (!ownsPanel && showResult && displayResult) {
    return {
      decorations,
      body: {
        kind: 'result',
        result: displayResult,
        presentation: 'shared',
        toolName: item.toolName,
        args: item.args,
        shellRunSource: item.shellRunSource,
      },
    };
  }

  if (!ownsPanel && item.args && !permissionDenied && !invocationLine) {
    return {
      decorations,
      body: {
        kind: 'argsOnly',
        text: formatQuietJsonValue(item.args, locale).body,
      },
    };
  }

  if (!ownsPanel && invocationLine) {
    return {
      decorations,
      body: {
        kind: 'quietText',
        body: invocationLine,
      },
    };
  }

  return { decorations, body: { kind: 'none' } };
}

function ToolCallDetailBody(props: {
  body: DetailDecision['body'];
  actionIdentity: string;
}) {
  const { body } = props;
  switch (body.kind) {
    case 'live':
      return (
        <ToolOutputSurface
          kind="live_stream"
          heading={body.heading}
          actionIdentity={props.actionIdentity}
        >
          <ToolOutputStream
            chunks={body.chunks}
            live={body.live}
            truncated={body.truncated}
          />
        </ToolOutputSurface>
      );
    case 'quietText':
      return (
        <div data-slot="tool-output" className="maka-tool-output-stack">
          <ToolCodeBlock
            code={body.body}
            title={body.title}
            actionIdentity={props.actionIdentity}
          />
        </div>
      );
    case 'argsOnly':
      return (
        <div data-slot="tool-output" className="maka-tool-output-stack">
          <ToolCodeBlock
            code={body.text}
            language="json"
            actionIdentity={props.actionIdentity}
          />
        </div>
      );
    case 'loadTool':
      return (
        <LoadToolResultPreview
          args={body.args}
          value={body.result.value}
          actionIdentity={props.actionIdentity}
        />
      );
    case 'result': {
      const preview = (
        <ToolResultPreview
          content={body.result}
          toolName={body.toolName}
          args={body.args}
          shellRunSource={body.shellRunSource}
          actionIdentity={props.actionIdentity}
        />
      );
      return body.presentation === 'shared'
        ? <div data-slot="tool-output" className="maka-tool-output-stack">{preview}</div>
        : preview;
    }
    case 'none':
      return null;
  }
}

/**
 * What a tool row reveals when expanded: the sandbox banner, the invocation,
 * live output or the settled result preview. Exported because Astryx owns the
 * row's expansion state internally — this panel is the seam where the product
 * decides what a result looks like, and it is asserted directly.
 */
export function ToolCallDetail({
  item,
  activityObserved = true,
  onSwitchToBypassAndRetry,
}: {
  item: ToolActivityItem;
  activityObserved?: boolean;
  onSwitchToBypassAndRetry?(): void | Promise<void>;
}) {
  const locale = useUiLocale();
  const decision = describeToolCall(item, locale, activityObserved);
  const actionIdentity = [
    computerActionLabel(item, locale) ?? resolveToolDisplayName(item, locale),
    item.intent ? formatToolIntent(item.intent) : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ');

  return (
    <div className="maka-tool-call-detail">
      {decision.decorations.sandboxBlockedResult && (
        <SandboxBlockedBanner result={decision.decorations.sandboxBlockedResult} />
      )}
      {decision.decorations.requiresBypass && (
        <RequiresBypassBanner onSwitchToBypassAndRetry={onSwitchToBypassAndRetry} />
      )}
      <ToolCallDetailBody body={decision.body} actionIdentity={actionIdentity} />
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
  activityObserved = true,
  onOpenLinkedSession,
  onSwitchToBypassAndRetry,
}: {
  items: ToolActivityItem[];
  activityObserved?: boolean;
  onOpenLinkedSession?(sessionId: string): void;
  onSwitchToBypassAndRetry?(): void | Promise<void>;
}) {
  const locale = useUiLocale();
  if (items.length === 0) return null;
  const segments = toolTrowSegments(items, locale, activityObserved, onSwitchToBypassAndRetry);

  // ChatToolCalls owns expandable tool evidence. Linked child sessions are
  // navigation targets instead, so they render through Astryx's compact List:
  // one native clickable row, with no parallel action button.
  return (
    <>
      {segments.map((segment) => segment.kind === 'tools' ? (
        <ChatToolCalls
          key={segment.key}
          className="maka-tool-activity-card"
          data-activity-observed={activityObserved}
          data-maka-transcript-boundary=""
          calls={segment.calls}
        />
      ) : (
        <LinkedAgentList
          key={segment.key}
          rows={segment.rows}
          activityObserved={activityObserved}
          locale={locale}
          onOpenLinkedSession={onOpenLinkedSession}
        />
      ))}
    </>
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

function toolTrowSegments(
  items: ToolActivityItem[],
  locale: UiLocale,
  activityObserved: boolean,
  onSwitchToBypassAndRetry?: () => void | Promise<void>,
): ToolTrowSegment[] {
  const segments: ToolTrowSegment[] = [];
  let computerTarget: string | undefined;
  for (const item of items) {
    const rows = linkedAgentRows(item, locale);
    const previous = segments.at(-1);
    if (rows) {
      if (previous?.kind === 'agents') previous.rows.push(...rows);
      else segments.push({ kind: 'agents', key: item.toolUseId, rows });
      continue;
    }
    const ownComputerTarget = computerActionTarget(item, locale);
    if (ownComputerTarget) computerTarget = ownComputerTarget;
    const call = standardToolCall(
      item,
      locale,
      activityObserved,
      isComputerTool(item) && !computerActionLabelIncludesTarget(item)
        ? computerTarget
        : undefined,
      onSwitchToBypassAndRetry,
    );
    if (previous?.kind === 'tools') previous.calls.push(call);
    else segments.push({ kind: 'tools', key: item.toolUseId, calls: [call] });
  }
  return segments;
}

function LinkedAgentList(props: {
  activityObserved: boolean;
  rows: LinkedAgentRow[];
  locale: UiLocale;
  onOpenLinkedSession?: (sessionId: string) => void;
}) {
  const activityCopy = getToolActivityCopy(props.locale);
  const copy = activityCopy.agent;
  return (
    <List density="compact" data-maka-transcript-boundary="">
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
                isPulsing={props.activityObserved && row.status === 'running'}
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
                  <VisuallyHidden>{activityCopy.errorLabel}: {row.failureClass}</VisuallyHidden>
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

function standardToolCall(
  item: ToolActivityItem,
  locale: UiLocale,
  activityObserved: boolean,
  inferredTarget?: string,
  onSwitchToBypassAndRetry?: () => void | Promise<void>,
): ChatToolCallItem {
  return {
    key: item.toolUseId,
    // The name is what a person reads to tell one call from the next, and for
    // Computer Use the display name is "Maka Computer" — a noun, identical on
    // every row of a ten-call turn. A label derived from the call's own
    // arguments says what happened instead.
    name: computerActionLabel(item, locale) ?? resolveToolDisplayName(item, locale),
    status: astryxToolStatus(item),
    target: collapsedToolTarget(item, locale, inferredTarget),
    duration: formatDuration(item.durationMs) ?? undefined,
    errorMessage: toolCallErrorMessage(item, locale),
    stats: item.progress && isInFlightToolStatus(toolActivityPresentationStatus(item))
      ? `${item.progress.current}/${item.progress.total}`
      : outcomeWord(item, locale),
    ...diffStats(itemDiffs(item)),
    resultDetail: (
      <ToolDetailReveal>
        <ToolCallDetail
          item={item}
          activityObserved={activityObserved}
          onSwitchToBypassAndRetry={onSwitchToBypassAndRetry}
        />
        <MakaClientSlotOutlet
          name="conversation.tool.detail"
          owner={{
            callId: item.toolUseId,
            toolName: item.toolName,
            status: toolActivityPresentationStatus(item),
            ...(item.args === undefined ? {} : { args: item.args }),
            ...(item.result === undefined ? {} : { result: item.result }),
          }}
          options={{
            entryKey: item.toolName,
          }}
        />
      </ToolDetailReveal>
    ),
  };
}

/**
 * What the collapsed row (and a collapsed group's header) says about the call.
 * `intent` wins when the runtime authored one; otherwise fall back to the
 * shared invocation line derived from the call's args — or, during the live
 * window, from the bounded wire args preview (full args arrive at turn end).
 * Only the first line is shown, hard-capped so a long command cannot stretch
 * the group header (Astryx ellipsizes too, but the header row is shared).
 */
function collapsedToolTarget(
  item: ToolActivityItem,
  locale: UiLocale,
  preferred?: string,
): string | undefined {
  if (workHubControlStatus(item)) return undefined;
  if (item.intent) return formatToolIntent(item.intent);
  const line = preferred ?? formatToolInvocationLine(item, locale);
  if (!line) return undefined;
  const firstLine = line.split('\n')[0]!.trim();
  if (!firstLine) return undefined;
  return firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine;
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
  switch (toolActivityPresentationStatus(item)) {
    case 'completed': return 'complete';
    case 'errored':
    case 'interrupted': return 'error';
    case 'running': return 'running';
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
  if (isRequiresBypassToolResult(item.result)) {
    return getToolActivityCopy(locale).requiresBypass.errorMessage;
  }
  return summarizeErrorText(formatUserVisibleToolText(
    redactSecrets(extractErrorText(item.result, locale)),
    locale,
  )).replace(/^Error:\s*/i, '');
}

function RequiresBypassBanner(props: {
  onSwitchToBypassAndRetry?(): void | Promise<void>;
}) {
  const copy = getToolActivityCopy(useUiLocale()).requiresBypass;
  const [pending, setPending] = useState(false);

  async function switchAndRetry() {
    if (!props.onSwitchToBypassAndRetry || pending) return;
    setPending(true);
    try {
      await props.onSwitchToBypassAndRetry();
    } finally {
      setPending(false);
    }
  }

  return (
    <Banner
      status="warning"
      className="maka-requires-bypass-banner"
      icon={<ShieldAlert size={ICON_SIZE.chrome} aria-hidden="true" />}
      title={copy.title}
      description={copy.description}
      endContent={props.onSwitchToBypassAndRetry ? (
        <UiButton
          variant="primary"
          size="sm"
          isDisabled={pending}
          aria-busy={pending || undefined}
          onClick={() => void switchAndRetry()}
          label={pending ? copy.pending : copy.action}
        />
      ) : undefined}
    />
  );
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
