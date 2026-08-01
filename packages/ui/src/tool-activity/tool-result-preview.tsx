import { useEffect, useRef } from 'react';
import {
  isShellOutput,
  normalizeSearchUrl,
  ptyHumanTerminalText,
  readWriteStdinInputPreview,
  type ShellOutput,
  type ToolResultContent,
} from '@maka/core';
import { AlertCircle, Ban, Check, Clock, GitBranch, Loader2, Plug, ShieldAlert } from '../icons.js';
import { redactSecrets } from '../redact.js';
import { useUiLocale } from '../locale-context.js';
import { cn } from '../ui.js';
import { AgentSwarmPreview, ExploreAgentPreview, SubagentPreview } from './agent-preview.js';
import { formatQuietJsonValue } from './builtin-preview.js';
import { ToolCodeBlock } from './tool-code-block.js';
import { TOOL_LINE_CAP, capLines, formatUserVisibleToolText } from './preview-utils.js';
import { getToolActivityCopy } from './copy.js';
import { isSandboxDeniedToolResult } from './sandbox-denial.js';

/**
 * Shared Codex-like tool output well — one surface for live and settled
 * mono/command output. Tokens only: foreground-3 + border + radius-surface.
 * Body type uses font-size-base (13px), not caption.
 */
export const TOOL_OUTPUT_PANEL_CLASS =
  'mt-1 grid gap-2 rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--foreground-3)] px-3 py-2.5';

export const TOOL_OUTPUT_COMMAND_CLASS =
  'block min-w-0 [font-family:var(--font-mono)] [font-variant-ligatures:none] text-[length:var(--font-size-base)] leading-normal text-[color:var(--foreground)] [white-space:pre-wrap] [word-break:break-word]';

export const TOOL_OUTPUT_BODY_CLASS =
  'm-0 max-h-64 overflow-y-auto whitespace-pre-wrap [word-break:break-word] [font-family:var(--font-mono)] [font-variant-ligatures:none] text-[length:var(--font-size-base)] leading-normal text-[color:var(--muted-foreground)] [scroll-behavior:auto]';

export const TOOL_OUTPUT_NOTE_CLASS =
  'm-0 text-[length:var(--font-size-base)] leading-normal text-[color:var(--muted-foreground)]';

/** Routes persisted tool results to bounded, kind-specific preview cards. */
export function ToolResultPreview(props: {
  content: ToolResultContent;
  toolName?: string;
  args?: unknown;
  shellRunSource?: 'owned' | 'unavailable';
}) {
  const { content } = props;
  const locale = useUiLocale();

  if (content.kind === 'file_diff') {
    return <FileDiffPreview diff={content.diff} paths={content.paths} />;
  }

  if (content.kind === 'web_search') {
    return (
      <WebSearchPreview query={content.query} provider={content.provider} rows={content.rows} />
    );
  }

  if (content.kind === 'web_search_error') {
    return (
      <WebSearchErrorPreview
        query={content.query}
        provider={content.provider}
        reason={content.reason}
        message={content.message}
        credentialSource={content.credentialSource}
      />
    );
  }

  if (content.kind === 'terminal') {
    return (
      <TerminalPreview
        cwd={content.cwd}
        cmd={content.cmd}
        exitCode={content.exitCode}
        status={content.status}
        failureMessage={content.failureMessage}
        output={isShellOutput(content.output) ? content.output : undefined}
        sandboxBlocked={isSandboxDeniedToolResult(content)}
      />
    );
  }

  if (content.kind === 'shell_run') {
    if (props.toolName === 'WriteStdin') return <PtyControlPreview result={content} args={props.args} />;
    return <ShellRunPreview result={content} source={props.shellRunSource} />;
  }

  if (content.kind === 'explore_agent') {
    return <ExploreAgentPreview result={content} />;
  }

  if (content.kind === 'subagent') {
    return <SubagentPreview result={content} />;
  }

  if (content.kind === 'agent_swarm') {
    return <AgentSwarmPreview result={content} />;
  }

  if (content.kind === 'rive_workflow') {
    return <RiveWorkflowPreview result={content} />;
  }

  if (content.kind === 'json') {
    // No language: quiet text must stay contiguous (tokenizer splits words).
    const quiet = formatQuietJsonValue(content.value, locale);
    return (
      <div data-kind="json">
        <ToolCodeBlock
          code={formatUserVisibleToolText(quiet.body, locale)}
          title={quiet.headline ? formatUserVisibleToolText(quiet.headline, locale) : undefined}
        />
      </div>
    );
  }

  if (content.kind === 'text') {
    const copy = getToolActivityCopy(locale).result;
    const { body, capped } = capLines(formatUserVisibleToolText(redactSecrets(content.text), locale));
    const code = capped > 0 ? `${body}\n\n${copy.hiddenLines(capped)}` : body;
    return (
      <div data-kind="text">
        <ToolCodeBlock code={code} />
      </div>
    );
  }

  // file_write / image / summary / unknown — show a compact descriptor so the
  // user knows what kind landed without dumping binary or storage refs.
  return (
    <div data-kind={content.kind}>
      <ToolCodeBlock code={`[${content.kind}]`} />
    </div>
  );
}

function PtyControlPreview(props: {
  result: Extract<ToolResultContent, { kind: 'shell_run' }>;
  args?: unknown;
}) {
  const copy = getToolActivityCopy(useUiLocale()).result;
  const operation = props.result.operation;
  if (operation?.kind !== 'pty_control') {
    return <p className={cn(TOOL_OUTPUT_NOTE_CLASS, 'text-[color:var(--destructive)]')}>{copy.ptyFailed}</p>;
  }
  const parts: string[] = [];
  if (operation.input) {
    const preview = readWriteStdinInputPreview(props.args);
    const action = operation.input.queued ? copy.queued : copy.notQueued;
    if (preview) {
      parts.push(preview.truncated
        ? copy.queuedPreview(action, preview.text, operation.input.bytes)
        : copy.queuedPreview(action, preview.text));
    } else {
      parts.push(copy.byteCount(action, operation.input.bytes));
    }
  }
  if (operation.resize) {
    const size = `${operation.resize.cols}x${operation.resize.rows}`;
    if (!operation.resize.applied) parts.push(copy.resizeNotApplied(size));
    else if (operation.resize.changed) parts.push(copy.resized(size));
    else if (!operation.input) parts.push(copy.sizeUnchanged(size));
  }
  if (operation.failed) parts.push(copy.ptyFailed);
  return (
    <p className={cn(
      TOOL_OUTPUT_NOTE_CLASS,
      'min-w-0 [overflow-wrap:anywhere]',
      operation.failed && 'text-[color:var(--destructive)]',
    )}>
      {parts.join(' · ') || copy.ptyCompleted}
    </p>
  );
}

/**
 * Line-level diff coloring. Splits the unified-diff text on newlines and
 * tags each line with `data-line="add" | "del" | "hunk" | "meta" | "ctx"`
 * for CSS to color. Doesn't try to parse the hunk semantics — we leave
 * that to a future inline editor view; this is just a readable preview.
 */
function FileDiffPreview(props: { diff: string; paths: string[] }) {
  const copy = getToolActivityCopy(useUiLocale()).result;
  // Apply UI-level redaction then cap the displayed lines. Both are
  // @kenji's PR76 review items: never echo a token a tool happened to dump
  // into a diff (commit body, .env file diff, etc.), and never let a
  // 10k-line diff create 10k React elements.
  const { body, capped } = capLines(redactSecrets(props.diff));
  const code = capped > 0 ? `${body}\n\n${copy.hiddenLines(capped)}` : body;
  return (
    <div data-kind="file_diff">
      <ToolCodeBlock
        code={code}
        language="diff"
        title={props.paths.length > 0 ? props.paths.join(', ') : undefined}
      />
    </div>
  );
}

function TerminalPreview(props: {
  cwd: string;
  cmd: string;
  exitCode?: number;
  status?: string;
  failureMessage?: string;
  output?: ShellOutput;
  sandboxBlocked?: boolean;
}) {
  const activityCopy = getToolActivityCopy(useUiLocale());
  const copy = activityCopy.result;
  const cancelled = isCancelledStatus(props.status);
  const timedOut = props.status === 'timed_out';
  const succeeded = props.status === 'completed';
  const safeCmd = redactSecrets(props.cmd);

  return (
    <div
      data-slot="tool-output"
      data-kind="terminal"
      className="mt-1 flex min-w-0 flex-col gap-1.5"
    >
      {props.output ? (
        <ShellOutputBody
          output={props.output}
          failed={!succeeded}
          title={safeCmd.length > 0 ? safeCmd : undefined}
        />
      ) : (
        <>
          {safeCmd.length > 0 ? <ToolCodeBlock code={safeCmd} /> : null}
          <p className={TOOL_OUTPUT_NOTE_CLASS}>{copy.terminalUnavailable}</p>
        </>
      )}
      {props.failureMessage && (
        <p className={cn(TOOL_OUTPUT_NOTE_CLASS, props.sandboxBlocked ? 'text-[color:var(--warning-text,var(--info-text))]' : 'text-[color:var(--destructive)]')}>
          {redactSecrets(props.failureMessage)}
        </p>
      )}
      {cancelled && (
        <p className={cn(TOOL_OUTPUT_NOTE_CLASS, 'text-[color:var(--destructive)]')}>
          {props.exitCode !== undefined ? `${copy.cancelled} · ${copy.exitCode(props.exitCode)}` : copy.cancelled}
        </p>
      )}
      {timedOut && !cancelled && (
        <p className={cn(TOOL_OUTPUT_NOTE_CLASS, 'text-[color:var(--destructive)]')}>
          {props.exitCode !== undefined ? `${copy.timedOut} · ${copy.exitCode(props.exitCode)}` : copy.timedOut}
        </p>
      )}
      {props.sandboxBlocked && !cancelled && !timedOut && (
        <p className={cn(TOOL_OUTPUT_NOTE_CLASS, 'text-[color:var(--warning-text,var(--info-text))]')}>
          {props.exitCode !== undefined
            ? `${activityCopy.status.sandboxBlocked} · ${copy.exitCode(props.exitCode)}`
            : activityCopy.status.sandboxBlocked}
        </p>
      )}
    </div>
  );
}

/** Background Bash after handoff: a live terminal surface for PTY, the existing
 * command/status/ref preview for pipes. Never collapse either to `[shell_run]`. */
function ShellRunPreview(props: {
  result: Extract<ToolResultContent, { kind: 'shell_run' }>;
  source?: 'owned' | 'unavailable';
}) {
  const locale = useUiLocale();
  const copy = getToolActivityCopy(locale).result;
  const { result } = props;
  const sandboxBlocked = isSandboxDeniedToolResult(result);
  const safeCmd = redactSecrets(result.cmd);
  const output = isShellOutput(result.output) ? result.output : undefined;
  const attention = result.status === 'failed' || result.status === 'orphaned' || (result.exitCode !== undefined && result.exitCode !== 0);
  const attentionBorder = sandboxBlocked
    ? 'border-[oklch(from_var(--warning)_l_c_h_/_0.32)]'
    : 'border-[oklch(from_var(--destructive)_l_c_h_/_0.28)]';

  if (result.mode === 'pty') {
    return (
      <PtyShellSurface
        result={result}
        output={output?.mode === 'pty' ? output : undefined}
        safeCmd={safeCmd}
        attention={attention}
        sandboxBlocked={sandboxBlocked}
        source={props.source}
      />
    );
  }
  const safeRef = redactSecrets(result.ref);
  const statusLabel = props.source === 'owned'
    ? copy.managedBySource
    : props.source === 'unavailable'
      ? copy.sourceUnavailable
      : sandboxBlocked
        ? getToolActivityCopy(locale).status.sandboxBlocked
        : shellRunStatusLabel(result.status, locale);
  const pipeOutput = output?.mode === 'pipes' ? output : undefined;

  return (
    <div
      data-slot="tool-output"
      data-kind="shell_run"
      className={cn(TOOL_OUTPUT_PANEL_CLASS, attention && attentionBorder)}
    >
      {safeCmd.length > 0 && (
        <code className={TOOL_OUTPUT_COMMAND_CLASS}>{safeCmd}</code>
      )}
      <p className={TOOL_OUTPUT_NOTE_CLASS}>
        {statusLabel}
        {result.exitCode !== undefined ? ` · ${copy.exitCode(result.exitCode)}` : ''}
        {safeRef ? ` · ${safeRef}` : ''}
      </p>
      {result.failureMessage && (
        <p className={cn(TOOL_OUTPUT_NOTE_CLASS, sandboxBlocked ? 'text-[color:var(--warning-text,var(--info-text))]' : 'text-[color:var(--destructive)]')}>
          {redactSecrets(result.failureMessage)}
        </p>
      )}
      {pipeOutput ? (
        <ShellOutputBody
          output={pipeOutput}
          failed={result.status === 'failed' || result.status === 'orphaned'}
        />
      ) : (
        <p className={TOOL_OUTPUT_NOTE_CLASS}>{copy.noOutputYet}</p>
      )}
    </div>
  );
}

function PtyShellSurface(props: {
  result: Extract<ToolResultContent, { kind: 'shell_run' }>;
  output?: Extract<ShellOutput, { mode: 'pty' }>;
  safeCmd: string;
  attention: boolean;
  sandboxBlocked: boolean;
  source?: 'owned' | 'unavailable';
}) {
  const copy = getToolActivityCopy(useUiLocale()).result;
  const { result, output } = props;
  return (
    <div
      data-slot="tool-output"
      data-kind="pty-shell"
      className={cn(
        TOOL_OUTPUT_PANEL_CLASS,
        'gap-0 overflow-hidden p-0',
        props.attention && (
          props.sandboxBlocked
            ? 'border-[oklch(from_var(--warning)_l_c_h_/_0.32)]'
            : 'border-[oklch(from_var(--destructive)_l_c_h_/_0.28)]'
        ),
      )}
    >
      <header className="flex min-w-0 items-center px-3 pt-2.5 pb-1">
        <span className="text-[length:var(--font-size-base)] font-medium text-[color:var(--foreground-secondary)]">
          Shell
        </span>
      </header>
      <div className="grid min-w-0 gap-2 px-3 py-1.5">
        {props.safeCmd.length > 0 && (
          <code className={TOOL_OUTPUT_COMMAND_CLASS}>$ {props.safeCmd}</code>
        )}
        {output ? (
          <ShellOutputBody
            output={output}
            failed={result.status === 'failed' || result.status === 'orphaned'}
          />
        ) : (
          <p className={TOOL_OUTPUT_NOTE_CLASS}>
            {result.status === 'failed' || result.status === 'orphaned'
              ? copy.noTerminalFrame
              : copy.noOutputYet}
          </p>
        )}
        {result.failureMessage && (
          <p className={cn(TOOL_OUTPUT_NOTE_CLASS, props.sandboxBlocked ? 'text-[color:var(--warning-text,var(--info-text))]' : 'text-[color:var(--destructive)]')}>
            {redactSecrets(result.failureMessage)}
          </p>
        )}
      </div>
      <footer className="flex min-h-8 items-center justify-end gap-1.5 px-3 pt-1 pb-2.5 text-[length:var(--font-size-base)] text-[color:var(--muted-foreground)]">
        <ShellRunStatus
          status={result.status}
          exitCode={result.exitCode}
          source={props.source}
          sandboxBlocked={props.sandboxBlocked}
        />
      </footer>
    </div>
  );
}

function ShellRunStatus(props: {
  status: Extract<ToolResultContent, { kind: 'shell_run' }>['status'];
  exitCode?: number;
  source?: 'owned' | 'unavailable';
  sandboxBlocked?: boolean;
}) {
  const activityCopy = getToolActivityCopy(useUiLocale());
  const copy = activityCopy.result;
  if (props.source === 'owned') return <><GitBranch size={15} aria-hidden="true" />{copy.managedBySource}</>;
  if (props.source === 'unavailable') return <><GitBranch size={15} aria-hidden="true" />{copy.sourceUnavailable}</>;
  const suffix = props.exitCode !== undefined && props.exitCode !== 0 ? ` · ${copy.exitCode(props.exitCode)}` : '';
  if (props.sandboxBlocked) {
    return <><ShieldAlert size={15} aria-hidden="true" />{activityCopy.status.sandboxBlocked}{suffix}</>;
  }
  switch (props.status) {
    case 'starting':
    case 'running':
      return <><Loader2 size={15} aria-hidden="true" className="animate-spin" />{copy.running}</>;
    case 'completed':
      return <><Check size={15} aria-hidden="true" />{copy.success}</>;
    case 'failed':
      return <><AlertCircle size={15} aria-hidden="true" />{copy.failed}{suffix}</>;
    case 'timed_out':
      return <><Clock size={15} aria-hidden="true" />{copy.timedOut}{suffix}</>;
    case 'cancelled':
      return <><Ban size={15} aria-hidden="true" />{copy.cancelled}{suffix}</>;
    case 'orphaned':
      return <><Plug size={15} aria-hidden="true" />{copy.disconnected}</>;
  }
}

function ShellOutputBody(props: {
  output: ShellOutput;
  failed: boolean;
  title?: string;
}) {
  const copy = getToolActivityCopy(useUiLocale()).result;
  if (props.output.mode === 'pty') {
    const text = redactSecrets(ptyHumanTerminalText(props.output));
    return (
      <>
        {text ? <PtyTerminalSurface text={text} /> : (
          <p className={TOOL_OUTPUT_NOTE_CLASS}>
            {props.failed ? copy.noTerminalFrame : copy.noOutputYet}
          </p>
        )}
        {props.output.truncated && <p className={TOOL_OUTPUT_NOTE_CLASS}>{copy.terminalTruncated}</p>}
        {props.output.redacted && <p className={TOOL_OUTPUT_NOTE_CLASS}>{copy.terminalRedacted}</p>}
      </>
    );
  }
  const stdout = capLines(redactSecrets(props.output.stdout));
  const stderr = capLines(redactSecrets(props.output.stderr));
  const hiddenLines = stdout.capped + stderr.capped;
  const runtimeTruncated = props.output.stdoutTruncated || props.output.stderrTruncated;
  const hasOutput = props.output.stdout.length > 0 || props.output.stderr.length > 0;
  const parts: string[] = [];
  if (stdout.body) {
    parts.push(stdout.capped > 0
      ? `${stdout.body}\n\n${copy.streamHidden('stdout', stdout.capped)}`
      : stdout.body);
  }
  if (stderr.body) {
    parts.push(stderr.capped > 0
      ? `${stderr.body}\n\n${copy.streamHidden('stderr', stderr.capped)}`
      : stderr.body);
  }
  const code = parts.join('\n');
  return (
    <>
      {!hasOutput && !props.title && <p className={TOOL_OUTPUT_NOTE_CLASS}>{copy.noOutput}</p>}
      {(hasOutput || props.title) && (
        <ToolCodeBlock
          // No language: shell streams stay contiguous under the tokenizer.
          code={code || props.title || ''}
          title={code && props.title ? props.title : undefined}
        />
      )}
      {!hasOutput && props.title && (
        <p className={TOOL_OUTPUT_NOTE_CLASS}>{copy.noOutput}</p>
      )}
      {(runtimeTruncated || hiddenLines > 0) && (
        <p className={TOOL_OUTPUT_NOTE_CLASS}>
          {hiddenLines > 0 ? copy.streamsTruncated(TOOL_LINE_CAP) : copy.outputTruncated}
        </p>
      )}
      {props.output.redacted && <p className={TOOL_OUTPUT_NOTE_CLASS}>{copy.outputRedacted}</p>}
    </>
  );
}

function PtyTerminalSurface(props: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const followTail = useRef(true);
  useEffect(() => {
    const element = ref.current;
    if (element && followTail.current) element.scrollTop = element.scrollHeight;
  }, [props.text]);
  return (
    <pre
      ref={ref}
      className={cn(TOOL_OUTPUT_BODY_CLASS, 'overflow-auto [white-space:pre] [word-break:normal]')}
      data-stream="pty"
      style={{ whiteSpace: 'pre', wordBreak: 'normal' }}
      onScroll={(event) => {
        const element = event.currentTarget;
        followTail.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
      }}
    >
      {props.text}
    </pre>
  );
}

function isCancelledStatus(status: string | undefined): boolean {
  return status === 'cancelled';
}

function shellRunStatusLabel(status: string, locale: import('@maka/core').UiLocale): string {
  const copy = getToolActivityCopy(locale).result;
  const label = (copy.backgroundStatus as Readonly<Record<string, string>>)[status];
  return label ?? copy.backgroundUnknown(status);
}

function RiveWorkflowPreview(props: {
  result: Extract<ToolResultContent, { kind: 'rive_workflow' }>;
}) {
  const copy = getToolActivityCopy(useUiLocale()).result;
  const { result } = props;
  const rows = [
    [copy.workflow.action, result.action],
    [copy.workflow.status, result.state ?? result.projection?.state],
    ['workflow_run', result.ids.workflowRunId ?? result.projection?.workflowRunId],
    ['scheduler_run', result.ids.schedulerRunId ?? result.projection?.schedulerRunId],
    ['root_work', result.ids.rootWorkNodeId ?? result.projection?.rootWorkNodeId],
    ['scheduler_state', result.projection?.schedulerState],
    ['root_state', result.projection?.rootState],
  ].filter((row): row is [string, string] => typeof row[1] === 'string' && row[1].length > 0);
  const nodes = (result.nodes ?? []).slice(0, 12);
  const failureLines = result.error
    ? [
        '',
        copy.workflow.error,
        `reason: ${result.error.reason}`,
        `message: ${result.error.message}`,
        result.error.code ? `code: ${result.error.code}` : '',
        result.error.suggestedAction ? `suggested_action: ${result.error.suggestedAction}` : '',
      ].filter(Boolean)
    : [];
  const diagnosticLines = [
    result.stdoutTail ? `stdout_tail:\n${result.stdoutTail}` : '',
    result.stderrTail ? `stderr_tail:\n${result.stderrTail}` : '',
  ].filter(Boolean);
  const body = [
    result.ok ? 'Rive workflow completed' : 'Rive workflow failed',
    result.summary,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    ...(nodes.length > 0 ? ['', copy.workflow.nodes, ...nodes.map(formatRiveWorkflowNode)] : []),
    ...failureLines,
    ...(diagnosticLines.length > 0 ? ['', copy.workflow.diagnostics, ...diagnosticLines] : []),
  ].join('\n');
  const cappedPreview = capLines(redactSecrets(body));
  return (
    <pre className={TOOL_OUTPUT_BODY_CLASS} data-kind="rive_workflow">
      {cappedPreview.body}
      {cappedPreview.capped > 0 && `\n\n${copy.hiddenLines(cappedPreview.capped)}`}
    </pre>
  );
}

function formatRiveWorkflowNode(node: NonNullable<Extract<ToolResultContent, { kind: 'rive_workflow' }>['nodes']>[number]): string {
  const label = node.title ?? node.templateId ?? node.id ?? 'node';
  const attrs = [
    node.state,
    node.runner ? `runner=${node.runner}` : '',
    node.worker ? `worker=${node.worker}` : '',
  ].filter(Boolean).join(' · ');
  return attrs ? `- ${label}: ${attrs}` : `- ${label}`;
}

/**
 * PR-CHAT-WEB-SEARCH-RENDER-0 — plain-text card list for the gated
 * WebSearch agent tool result. Matches the Settings → 联网搜索 live-query
 * verification layout so the user gets the same shape whether the search came
 * from a manual verification run or the agent. Never renders markdown / HTML;
 * each cell is `redactSecrets`'d as a belt-and-braces guard against
 * a provider response that happened to echo a token.
 */
function WebSearchPreview(props: {
  query: string;
  provider: string;
  rows: ReadonlyArray<{ title: string; url: string; snippet: string; source: string }>;
}) {
  const copy = getToolActivityCopy(useUiLocale()).result;
  const rows = props.rows
    .map((row) => {
      const normalizedUrl = normalizeSearchUrl(row.url);
      if (!normalizedUrl.ok) return null;
      return { ...row, url: redactSecrets(normalizedUrl.value) };
    })
    .filter((row): row is { title: string; url: string; snippet: string; source: string } => row !== null);

  if (rows.length === 0) {
    return (
      <div className="grid gap-1.5 [font-family:var(--font-sans)]" data-kind="web_search">
        <header className="grid gap-0.5">
          <strong className="text-[length:var(--font-size-base)] text-[color:var(--foreground)]">{redactSecrets(props.query)}</strong>
          <small className="text-[length:var(--font-size-base)] text-[color:var(--muted-foreground)]">{props.provider} · {copy.webNoResults}</small>
        </header>
      </div>
    );
  }
  return (
    <div className="grid gap-2 [font-family:var(--font-sans)]" data-kind="web_search">
      <header className="grid gap-0.5">
        <strong className="text-[length:var(--font-size-base)] text-[color:var(--foreground)]">{redactSecrets(props.query)}</strong>
        <small className="text-[length:var(--font-size-base)] text-[color:var(--muted-foreground)]">
          {props.provider} · {copy.webResults(rows.length)}
        </small>
      </header>
      <ul className="m-0 grid list-none gap-2 p-0">
        {rows.map((row, idx) => (
          <li key={`${row.url}-${idx}`} className="grid gap-0.5">
            <a
              href={row.url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[length:var(--font-size-base)] font-medium text-[color:var(--link)]"
            >
              {redactSecrets(row.title)}
            </a>
            <small className="text-[length:var(--font-size-base)] text-[color:var(--muted-foreground)]">{redactSecrets(row.source)}</small>
            <p className="m-0 text-[length:var(--font-size-base)] leading-snug text-[color:var(--foreground-secondary)]">{redactSecrets(row.snippet)}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function WebSearchErrorPreview(props: {
  query?: string;
  provider: string;
  reason: string;
  message: string;
  credentialSource?: string;
}) {
  const copy = getToolActivityCopy(useUiLocale()).result;
  const sourceCopy =
    props.credentialSource === 'env'
      ? copy.credentialSource.env
      : props.credentialSource === 'saved'
        ? copy.credentialSource.settings
        : props.credentialSource === 'none'
          ? copy.credentialSource.missing
          : copy.credentialSource.unknown;
  const repairCopy =
    props.reason === 'invalid_credentials' && props.credentialSource === 'env'
      ? copy.webGuidance.env
      : props.reason === 'invalid_credentials'
        ? copy.webGuidance.settings
        : props.reason === 'rate_limited'
          ? copy.webGuidance.rate_limited
          : props.reason === 'not_configured'
            ? copy.webGuidance.not_configured
            : props.reason === 'timeout'
              ? copy.webGuidance.timed_out
              : props.reason === 'incognito_active'
                ? copy.webGuidance.privacy_mode
                : copy.webGuidance.unknown;
  return (
    <div className="grid gap-1.5 [font-family:var(--font-sans)]" data-kind="web_search_error">
      <header className="grid gap-0.5">
        <strong className="text-[length:var(--font-size-base)] text-[color:var(--foreground)]">{redactSecrets(props.query ?? copy.webSearch)}</strong>
        <small className="text-[length:var(--font-size-base)] text-[color:var(--muted-foreground)]">{redactSecrets(props.provider)} · {copy.webFailure} · {sourceCopy}</small>
      </header>
      <p className="m-0 text-[length:var(--font-size-base)] text-[color:var(--destructive)]">{redactSecrets(props.message)}</p>
      <p className="m-0 text-[length:var(--font-size-base)] text-[color:var(--muted-foreground)]">{repairCopy}</p>
    </div>
  );
}
