import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import type {
  AdditionalPermissionRequestEvent,
  AnyPermissionRequestEvent,
  PermissionRequestEvent,
  SandboxEscalationRequestEvent,
  PermissionResponse,
} from '@maka/core';
import {
  derivePermissionRequestHealth,
  formatPermissionRequestWait,
  formatWriteStdinPermissionInspection,
  projectWriteStdinPermissionSummary,
} from '@maka/core';
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from './primitives/collapsible.js';
import { Button as UiButton, Checkbox } from './ui.js';
import { redactSecrets } from './redact.js';
import { formatRedactedJson } from './tool-format.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy, type ConversationCopy } from './conversation-copy.js';

// Per-reason presentation hints. The headline states the decision while tone
// handles the minimum visual distinction needed for higher-risk requests.
type ReasonKind = PermissionRequestEvent['reason']
  | AdditionalPermissionRequestEvent['reason']
  | SandboxEscalationRequestEvent['reason'];

interface ReasonPreset {
  prompt: string;
  tone: 'info' | 'caution' | 'destructive';
}

const REASON_TONE: Record<ReasonKind, ReasonPreset['tone']> = {
  shell_dangerous: 'caution', file_write: 'info', fs_destructive: 'destructive', git_destructive: 'destructive', network: 'info', privileged: 'destructive', browser: 'caution', computer_use: 'caution', additional_permissions: 'caution', sandbox_escalation: 'destructive', custom: 'info',
};

export function PermissionPrompt(props: {
  request: AnyPermissionRequestEvent;
  // Accept Promise-returning impls so the prompt can await the IPC
  // and reset its own pending state when it resolves OR rejects.
  // The renderer's `respondToPermission` is async but was typed as
  // void by the legacy signature, which made `submit()` strand
  // `responsePending=true` if the IPC failed silently.
  onRespond(response: PermissionResponse): void | Promise<void>;
  onStop(): void | Promise<void>;
  stopPending?: boolean;
}) {
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).permissionPrompt;
  const [rememberForTurn, setRememberForTurn] = useState(false);
  const [expandedRequestId, setExpandedRequestId] = useState<string | null>(null);
  const [responsePending, setResponsePending] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const responsePendingRef = useRef(false);
  const denyButtonRef = useRef<HTMLButtonElement>(null);
  const permissionMountedRef = useMountedRef();
  const activePermissionRequestIdRef = useRef(props.request.requestId);

  useEffect(() => {
    activePermissionRequestIdRef.current = props.request.requestId;
    setRememberForTurn(false);
    setExpandedRequestId(null);
    setResponsePending(false);
    responsePendingRef.current = false;
    setNow(Date.now());
    const focusFrame = window.requestAnimationFrame(() => denyButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(focusFrame);
  }, [props.request.requestId]);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const interval = window.setInterval(tick, 30_000);
    return () => window.clearInterval(interval);
  }, [props.request.requestId]);

  async function submit(decision: PermissionResponse['decision']) {
    if (responsePendingRef.current) return;
    const requestId = props.request.requestId;
    responsePendingRef.current = true;
    setResponsePending(true);
    try {
      // PR-PERMISSION-UI-CLEANUP-0: await so the pending state
      // resets when the IPC settles. Previously a Promise-returning
      // onRespond would let the try/catch miss async rejections,
      // and on success the parent normally unmounts us — but if the
      // parent's own try/catch swallows the IPC error (PR-STOP-
      // ERROR-SURFACE-0 does exactly this), we'd stay mounted with
      // `responsePending=true` and the buttons would lock up.
      await props.onRespond({
        requestId,
        decision,
        ...(props.request.rememberForTurnAllowed
          ? { rememberForTurn: decision === 'allow' ? rememberForTurn : false }
          : {}),
      });
    } finally {
      if (activePermissionRequestIdRef.current === requestId) {
        responsePendingRef.current = false;
        if (permissionMountedRef.current) setResponsePending(false);
      }
    }
  }

  const fullArgsOpen = expandedRequestId === props.request.requestId;
  const reason = props.request.reason in REASON_TONE ? props.request.reason as ReasonKind : 'custom';
  const preset: ReasonPreset = { prompt: copy.reason[reason], tone: REASON_TONE[reason] };
  const summary = renderPermissionSummary(props.request, copy);
  const details = renderPermissionDetails(props.request, fullArgsOpen);
  const additionalArgs = permissionAdditionalArgs(props.request);
  const showDisclosure = props.request.toolName === 'WriteStdin'
    || details !== undefined
    || additionalArgs !== undefined;
  const disclosureLabel = permissionDisclosureLabel(props.request, additionalArgs, copy);
  const prompt = permissionPrompt(props.request, preset, copy);
  const isDestructive = preset.tone === 'destructive';
  const context = props.request.hint ?? (isDestructive
    ? copy.destructiveContext
    : undefined);
  const health = derivePermissionRequestHealth({ requestedAt: props.request.ts, now });
  const waitLabel = formatPermissionRequestWait(health.ageMs, locale);
  const decisionsDisabled = props.stopPending || responsePending;

  return (
    <section
      role="region"
      className="maka-composer-interaction maka-permission-prompt composer"
      aria-labelledby="permissionTitle"
      data-tone={preset.tone}
    >
      <div className="maka-composer-interaction-inner maka-permission-prompt-inner agents-parchment-paper-surface">
        <header className="maka-permission-header">
          <div className="maka-permission-title-row">
            <h2 className="maka-permission-title" id="permissionTitle">{prompt}</h2>
            {health.status !== 'fresh' && (
              <span className="maka-permission-age" data-status={health.status}>
                {copy.waited(waitLabel)}
              </span>
            )}
          </div>
        </header>
        <div className="maka-permission-body">
          {summary && <div className="maka-permission-summary">{summary}</div>}
          {context && (
            <p className="maka-permission-context" data-tone={preset.tone}>{context}</p>
          )}
          {props.request.reason === 'browser' && rememberForTurn && (
            <p className="maka-permission-context">
              {copy.rememberBrowser}
            </p>
          )}
          {props.request.reason === 'computer_use' && rememberForTurn && (
            <p className="maka-permission-context" role="note">
              {copy.rememberScoped}
            </p>
          )}
        </div>
        <Collapsible
          className="maka-permission-raw"
          open={fullArgsOpen}
          onOpenChange={(open) => setExpandedRequestId(open ? props.request.requestId : null)}
        >
          {showDisclosure && (
            <CollapsiblePanel>
              {details && <div className="maka-permission-details">{details}</div>}
              {additionalArgs && <pre className="maka-code">{formatRedactedJson(additionalArgs)}</pre>}
            </CollapsiblePanel>
          )}
          <footer className="permissionActions">
            <div className="maka-permission-utility-actions">
              {showDisclosure && <CollapsibleTrigger>{disclosureLabel}</CollapsibleTrigger>}
              {props.request.rememberForTurnAllowed && (
                <label className="permissionRemember">
                  <Checkbox
                    checked={rememberForTurn}
                    disabled={decisionsDisabled}
                    onCheckedChange={(checked) => setRememberForTurn(checked === true)}
                  />
                  {copy.rememberTurn}
                </label>
              )}
            </div>
            <div className="maka-permission-decision-actions" role="group" aria-label={copy.actionsAriaLabel}>
              <UiButton
                variant="ghost"
                size="md"
                type="button"
                disabled={props.stopPending}
                onClick={() => void props.onStop()}
              >
                {props.stopPending ? copy.stopping : copy.stop}
              </UiButton>
              <UiButton
                ref={denyButtonRef}
                variant="ghost"
                size="md"
                type="button"
                disabled={decisionsDisabled}
                onClick={() => submit('deny')}
              >
                {copy.deny}
              </UiButton>
              <UiButton
                variant={isDestructive ? 'destructive' : 'default'}
                size="md"
                type="button"
                disabled={decisionsDisabled}
                onClick={() => submit('allow')}
              >
                {responsePending ? copy.submitting
                  : isOneShotPermissionRequest(props.request) ? copy.allowOnce : copy.allow}
              </UiButton>
            </div>
          </footer>
        </Collapsible>
      </div>
    </section>
  );
}

/**
 * One-line summary for a browser_* action. Names the concrete action (open /
 * read / click / type) so the prompt reads as a real browser step, not an opaque
 * tool call — reinforcing that a browser grant spans reads AND acts. The typed
 * text and full args stay in the raw Collapsible block below.
 */
function renderBrowserSummary(toolName: string, args: Record<string, unknown>, copy: ConversationCopy['permissionPrompt']): ReactNode {
  const ref = typeof args.ref === 'string' ? args.ref : '';
  const url = typeof args.url === 'string' ? args.url : '';
  const selector = typeof args.selector === 'string' ? args.selector : '';
  const line =
    toolName === 'browser_navigate'
      ? copy.browser.navigate(url || copy.browser.urlFallback)
      : toolName === 'browser_click'
        ? copy.browser.click(ref)
        : toolName === 'browser_type'
          ? copy.browser.type(ref)
          : toolName === 'browser_snapshot'
            ? copy.browser.snapshot
            : toolName === 'browser_extract'
              ? copy.browser.extract(selector)
              : toolName === 'browser_wait'
                ? copy.browser.wait
                : copy.browser.generic;
  return <p className="maka-permission-line">{line}</p>;
}

/**
 * Per-tool human-readable summary of what the request will do, used at the
 * top of the permission prompt body. Falls back to undefined if we can't
 * recognize the tool — the raw args Collapsible block is always available.
 */
function renderPermissionSummary(request: AnyPermissionRequestEvent, copy: ConversationCopy['permissionPrompt']): ReactNode | undefined {
  if (isAdditionalPermissionRequest(request)) {
    const entries = request.additionalPermissions.fileSystem?.entries ?? [];
    return (
      <>
        <p className="maka-permission-line">{request.justification}</p>
        <p className="maka-permission-meta">{copy.workingDirectory} <code>{redactSecrets(request.cwd)}</code></p>
        {entries.map((entry) => (
          <p className="maka-permission-path" key={`${entry.access}:${entry.scope}:${entry.path}`}>
            <code>{redactSecrets(entry.path)}</code>
            {' · '}{entry.access === 'write' ? copy.readWrite : copy.readOnly}
            {' · '}{entry.scope === 'exact' ? copy.exactPath : copy.directoryTree}
          </p>
        ))}
        {request.risk.networkEnabled && (
          <p className="maka-permission-meta">{copy.temporaryNetwork}</p>
        )}
        {request.risk.outsideWorkspace && (
          <p className="maka-permission-meta">{copy.outsideWorkspace}</p>
        )}
        {request.risk.protectedMetadata && (
          <p className="maka-permission-meta">{copy.protectedMetadata}</p>
        )}
      </>
    );
  }
  if (isSandboxEscalationRequest(request)) {
    return (
      <>
        <p className="maka-permission-line">{request.justification}</p>
        <p className="maka-permission-meta">{copy.workingDirectory} <code>{redactSecrets(request.cwd)}</code></p>
        <pre className="maka-code maka-permission-command">{redactSecrets(request.command)}</pre>
        <p className="maka-permission-context" data-tone="destructive">
          {copy.outsideSandbox}
        </p>
      </>
    );
  }
  const args = (request.args ?? {}) as Record<string, unknown>;
  switch (request.toolName) {
    case 'maka_computer': {
      const action = typeof args.action === 'string' ? args.action : 'unknown';
      const approvalClass = typeof args.approvalClass === 'string' ? args.approvalClass : 'unknown';
      const app = typeof args.app === 'string' ? args.app : undefined;
      const windowId = typeof args.windowId === 'number' ? args.windowId : undefined;
      return (
        <>
          <p className="maka-permission-line">
            Computer Use：<code>{action}</code>（{approvalClass}）
          </p>
          {(app || windowId !== undefined) && (
            <p className="maka-permission-meta">
              {copy.target} {app ?? copy.currentApp}{windowId !== undefined ? ` · window ${windowId}` : ''}
            </p>
          )}
        </>
      );
    }
    case 'browser_navigate':
    case 'browser_snapshot':
    case 'browser_click':
    case 'browser_type':
    case 'browser_wait':
    case 'browser_extract':
      return renderBrowserSummary(request.toolName, args, copy);
    case 'Bash': {
      const command = typeof args.command === 'string' ? args.command : undefined;
      const cwd = typeof args.cwd === 'string' ? args.cwd : undefined;
      if (!command) return undefined;
      const commandSummary = cwd
        ? `${copy.inDirectory(redactSecrets(cwd))}\n${redactSecrets(command)}`
        : redactSecrets(command);
      return <pre className="maka-code maka-permission-command">{commandSummary}</pre>;
    }
    case 'WriteStdin': {
      const writeStdin = projectWriteStdinPermissionSummary(args);
      if (!writeStdin.ref && !writeStdin.input && !writeStdin.size) return undefined;
      return (
        <>
          <p className="maka-permission-line">{copy.terminalInteraction}</p>
          {writeStdin.ref && (
            <p className="maka-permission-path">
              <code>{writeStdin.ref.text}{writeStdin.ref.truncated ? '…' : ''}</code>
            </p>
          )}
          {writeStdin.input && (
            <>
              <pre className="maka-code maka-permission-preview">
                {writeStdin.input.text}{writeStdin.input.truncated ? '…' : ''}
              </pre>
              {writeStdin.input.truncated && (
                <p className="maka-permission-meta">
                  {copy.fullInputBytes(writeStdin.input.bytes)}
                </p>
              )}
            </>
          )}
          {writeStdin.size && (
            <p className="maka-permission-meta">
              {copy.targetSize(writeStdin.size.cols, writeStdin.size.rows)}
            </p>
          )}
        </>
      );
    }
    case 'Write': {
      const path = typeof args.path === 'string' ? args.path : undefined;
      const content = typeof args.content === 'string' ? args.content : '';
      if (!path) return undefined;
      const bytes = new TextEncoder().encode(content).length;
      const lines = countTextLines(content);
      return (
        <>
          <p className="maka-permission-path"><code>{redactSecrets(path)}</code></p>
          <p className="maka-permission-meta">
            {copy.byteLineCount(bytes, lines)}
          </p>
        </>
      );
    }
    case 'Edit': {
      const path = typeof args.path === 'string' ? args.path : undefined;
      if (!path) return undefined;
      const oldString = typeof args.old_string === 'string' ? args.old_string : '';
      const newString = typeof args.new_string === 'string' ? args.new_string : '';
      const oldLines = countTextLines(oldString);
      const newLines = countTextLines(newString);
      return (
        <>
          <p className="maka-permission-path"><code>{redactSecrets(path)}</code></p>
          <p className="maka-permission-meta">
            {copy.editLineCount(oldLines, newLines)}
          </p>
        </>
      );
    }
    case 'WebFetch': {
      const url = typeof args.url === 'string' ? args.url : undefined;
      if (!url) return undefined;
      return <p className="maka-permission-path"><code>{redactSecrets(url)}</code></p>;
    }
    default:
      return request.toolName
        ? <p className="maka-permission-line">{request.toolName}</p>
        : undefined;
  }
}

function renderPermissionDetails(
  request: AnyPermissionRequestEvent,
  writeStdinExpanded: boolean,
): ReactNode | undefined {
  if (isAdditionalPermissionRequest(request)) return undefined;
  const args = (request.args ?? {}) as Record<string, unknown>;
  switch (request.toolName) {
    case 'WriteStdin': {
      if (!writeStdinExpanded) return undefined;
      const inspection = formatWriteStdinPermissionInspection(args);
      if (!inspection) return undefined;
      return (
        <pre className="maka-code maka-permission-preview">
          {inspection}
        </pre>
      );
    }
    case 'Write': {
      const content = typeof args.content === 'string' ? args.content : '';
      if (!content) return undefined;
      return <pre className="maka-code maka-permission-preview">{permissionTextPreview(content, 600)}</pre>;
    }
    case 'Edit': {
      const oldString = typeof args.old_string === 'string' ? args.old_string : '';
      const newString = typeof args.new_string === 'string' ? args.new_string : '';
      return (
        <div className="maka-permission-diff">
          <pre className="maka-permission-diff-lines" data-side="old">
            {prefixPermissionDiff(permissionTextPreview(oldString, 400), '-')}
          </pre>
          <pre className="maka-permission-diff-lines" data-side="new">
            {prefixPermissionDiff(permissionTextPreview(newString, 400), '+')}
          </pre>
        </div>
      );
    }
    default:
      return undefined;
  }
}

function permissionAdditionalArgs(request: AnyPermissionRequestEvent): Record<string, unknown> | undefined {
  if (isAdditionalPermissionRequest(request)) return undefined;
  const args = (request.args ?? {}) as Record<string, unknown>;
  switch (request.toolName) {
    case 'Bash': {
      const { command: _command, cwd: _cwd, ...additional } = args;
      return Object.keys(additional).length > 0 ? additional : undefined;
    }
    case 'Write':
    case 'Edit':
    case 'WriteStdin':
      return undefined;
    default:
      return Object.keys(args).length > 0 ? args : undefined;
  }
}

function permissionTextPreview(value: string, maxChars: number): string {
  const safe = redactSecrets(value);
  return safe.length > maxChars ? `${safe.slice(0, maxChars)}…` : safe;
}

function countTextLines(value: string): number {
  if (!value) return 0;
  const lines = value.split(/\r?\n/);
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

function prefixPermissionDiff(value: string, prefix: '-' | '+'): string {
  return value.split('\n').map((line) => `${prefix} ${line}`).join('\n');
}

function permissionPrompt(request: AnyPermissionRequestEvent, preset: ReasonPreset, copy: ConversationCopy['permissionPrompt']): string {
  if (isAdditionalPermissionRequest(request)) return copy.additionalPermission;
  if (isSandboxEscalationRequest(request)) return copy.sandboxEscalation;
  if (request.toolName === 'Edit') return copy.editFile;
  return preset.prompt;
}

function permissionDisclosureLabel(
  request: AnyPermissionRequestEvent,
  additionalArgs: Record<string, unknown> | undefined,
  copy: ConversationCopy['permissionPrompt'],
): string {
  switch (request.toolName) {
    case 'Edit':
      return copy.disclosure.changes;
    case 'Write':
      return copy.disclosure.content;
    case 'WriteStdin':
      return copy.disclosure.input;
    default:
      return additionalArgs ? copy.disclosure.fullArguments : copy.disclosure.details;
  }
}

function isAdditionalPermissionRequest(
  request: AnyPermissionRequestEvent,
): request is AdditionalPermissionRequestEvent {
  return request.kind === 'additional_permissions';
}

function isSandboxEscalationRequest(
  request: AnyPermissionRequestEvent,
): request is SandboxEscalationRequestEvent {
  return request.kind === 'sandbox_escalation';
}

function isOneShotPermissionRequest(request: AnyPermissionRequestEvent): boolean {
  return isAdditionalPermissionRequest(request) || isSandboxEscalationRequest(request);
}
