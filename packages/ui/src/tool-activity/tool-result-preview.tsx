import { useEffect, useRef, type ReactNode } from 'react';
import { isShellOutput, type ShellOutput } from '@maka/core/shell-run';
import { normalizeSearchUrl } from '@maka/core/search';
import { ptyHumanTerminalText } from '@maka/core/pty-output-view';
import { readWriteStdinInputPreview } from '@maka/core/tool-activity-args';
import { type ToolResultContent } from '@maka/core/events';
import { Button as UiButton, Link } from '@astryxdesign/core';
import { ICON_SIZE, AlertCircle, Ban, Check, Clock, Copy, GitBranch, Loader2, Plug, ShieldAlert } from '../icons.js';
import { redactSecrets } from '../redact.js';
import { useClipboardCopyFeedback } from '../clipboard-feedback.js';
import { useUiLocale } from '../locale-context.js';
import { cn } from '../ui.js';
import { ExploreAgentPreview } from './agent-preview.js';
import { formatQuietJsonValue } from './builtin-preview.js';
import { ToolCodeBlock } from './tool-code-block.js';
import { DiffCodePreview } from './diff-code-preview.js';
import { TOOL_LINE_CAP, capLines, formatUserVisibleToolText } from './preview-utils.js';
import { getToolActivityCopy } from './copy.js';
import { isSandboxDeniedToolResult } from './sandbox-denial.js';

/**
 * Shared Codex-like tool output well — one surface for live and settled
 * mono/command output. Tokens only: foreground-3 + border + radius-surface.
 * Body type uses font-size-base (the body tier), not caption.
 */
export const TOOL_OUTPUT_PANEL_CLASS =
  'maka-tool-output-panel';

export const TOOL_OUTPUT_COMMAND_CLASS =
  'maka-tool-output-command';

export const TOOL_OUTPUT_BODY_CLASS =
  'maka-tool-output-body';

export const TOOL_OUTPUT_NOTE_CLASS =
  'maka-tool-output-note';

/**
 * The one surface a tool result and the line naming it share.
 *
 * A single Bash call used to render three different ways depending on which
 * branch it landed in: streaming put the command in an Astryx `CodeBlock` card
 * with the output as loose text beside it, a settled foreground run passed the
 * command as that CodeBlock's `title` (comment-coloured mono, no rule, tucked
 * against the body — it read as a commented-out first line rather than a
 * header), and a settled background run used this panel. So the same call
 * changed shape as it finished.
 *
 * One panel now owns all three, and the file-diff preview besides: the heading
 * on top in foreground mono, a hairline, then the body.
 *
 * The one action copies both. Astryx's CodeBlock copy button reached only the
 * code, leaving the command it carried as `title` unreachable; a button that
 * reached only the heading would have traded that for the reverse, and losing
 * one-click copy of an error's output is the worse half of the trade. `body` is
 * the plain text of `children` — the same capped, redacted string the body
 * renders — so callers that have it pass it, and the rest copy the heading
 * alone.
 */
export function ToolOutputSurface(props: {
  kind: string;
  heading?: string;
  body?: string;
  attention?: 'error' | 'warning';
  actions?: ReactNode;
  children: ReactNode;
}) {
  const copyText = getToolActivityCopy(useUiLocale()).copy;
  const feedback = useClipboardCopyFeedback();
  const command = props.heading?.trim() ? props.heading : undefined;
  const copyPayload = [command, props.body].filter(Boolean).join('\n');
  // Each surface owns its own feedback hook, so the key never has to
  // distinguish one surface from another — it only has to be stable across
  // this surface's renders.
  const copyKey = `tool-output:${props.kind}`;
  const phase = feedback.phaseFor(copyKey);
  const label = phase === 'pending'
    ? copyText.pending
    : phase === 'copied'
      ? copyText.copied
      : phase === 'failed'
        ? copyText.failed
        : copyText.idle;

  return (
    <div
      data-slot="tool-output"
      data-kind={props.kind}
      className={cn(
        TOOL_OUTPUT_PANEL_CLASS,
        props.attention === 'error' && 'maka-tool-output-destructive-border',
        props.attention === 'warning' && 'maka-tool-output-warning-border',
      )}
    >
      {command && (
        <div className="maka-tool-output-command-row">
          <code className={TOOL_OUTPUT_COMMAND_CLASS}>{command}</code>
          <div className="maka-tool-output-command-actions">
            {props.actions}
            <UiButton
              variant="ghost"
              size="sm"
              className="maka-tool-output-command-copy"
              data-copy-feedback={phase ?? undefined}
              // Icon-only: the heading already fills the row, and a word beside
              // it would compete with the thing being copied. `label` is the
              // accessible name in this mode.
              isIconOnly
              label={label}
              aria-busy={phase === 'pending' ? 'true' : undefined}
              isDisabled={phase === 'pending'}
              onClick={() => void feedback.copy(copyKey, copyPayload)}
              icon={phase === 'copied'
                ? <Check size={ICON_SIZE.control} aria-hidden="true" />
                : <Copy size={ICON_SIZE.control} aria-hidden="true" />}
            />
          </div>
        </div>
      )}
      {props.children}
    </div>
  );
}

/** Routes persisted tool results to bounded, kind-specific preview cards. */
export function ToolResultPreview(props: {
  content: ToolResultContent;
  toolName?: string;
  args?: unknown;
  shellRunSource?: 'owned' | 'unavailable';
  fileDiffActions?: ReactNode;
}) {
  const { content } = props;
  const locale = useUiLocale();

  if (content.kind === 'file_diff') {
    return (
      <FileDiffPreview
        diff={content.diff}
        paths={content.paths}
        actions={props.fileDiffActions}
      />
    );
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

  // image / summary / unknown — show a compact descriptor so the user knows
  // what kind landed without dumping binary or storage refs.
  if (content.kind === 'file_write') {
    return (
      <div data-kind={content.kind}>
        <ToolCodeBlock code={`Wrote ${content.bytes} bytes to ${content.path}`} />
      </div>
    );
  }
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
    return <p className={cn(TOOL_OUTPUT_NOTE_CLASS, 'maka-tool-output-destructive')}>{copy.ptyFailed}</p>;
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
      'maka-tool-output-wrap',
      operation.failed && 'maka-tool-output-destructive',
    )}>
      {parts.join(' · ') || copy.ptyCompleted}
    </p>
  );
}

/**
 * Which tint a unified-diff line takes. Deliberately shallow: it reads the
 * line's first character, not the hunk semantics, which is all the colouring
 * needs and all a preview should promise.
 *
 * `+++`/`---` are file markers, not an addition and a deletion — they have to
 * be tested before the single-character cases or every diff opens with one
 * green and one red line that mean nothing.
 */
export function diffLineKind(line: string): 'add' | 'del' | 'hunk' | 'meta' | 'ctx' {
  // The trailing space is what separates a file marker from content: unified
  // diff writes `--- a/path`, never a bare `---`. Without it, deleting a YAML
  // document separator or an SQL `--` comment paints the removal as a header —
  // the one line the reader most needs to see as red.
  if (line.startsWith('--- ') || line.startsWith('+++ ')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'meta';
  return 'ctx';
}

/**
 * Line-level diff colouring — green additions, red deletions, a tinted hunk
 * header — in the same surface a command uses, with the changed paths as its
 * heading.
 *
 * This was passing `language="diff"` to Astryx's CodeBlock, which does not
 * know that language: `buildLanguagePatterns` has no `diff` case and returns
 * null, so every line fell through to `--color-syntax-variable` and the whole
 * hunk painted one colour. Astryx ships no diff component, so the product owns
 * this. The `.maka-tool-diff-*` classes it renders through are the ones
 * `previewVariants` has always declared for exactly this — the call site was
 * what went missing.
 *
 * The row is three columns, not a tinted string: the line number, the `+`/`-`
 * marker, and the code. Splitting the marker out is what lets the code keep
 * the file's own indentation and take real syntax colouring (see
 * `diff-syntax.ts`); the tint and the marker carry add/del between them, so
 * the code no longer has to be uniformly green or red to say which it is.
 */
function FileDiffPreview(props: {
  diff: string;
  paths: string[];
  actions?: ReactNode;
}) {
  const copy = getToolActivityCopy(useUiLocale()).result;
  // Apply UI-level redaction then cap the displayed lines. Both are
  // @kenji's PR76 review items: never echo a token a tool happened to dump
  // into a diff (commit body, .env file diff, etc.), and never let a
  // 10k-line diff create 10k React elements.
  const { body, capped } = capLines(redactSecrets(props.diff));
  return (
    <ToolOutputSurface
      kind="file_diff"
      heading={props.paths.length > 0 ? props.paths.join(', ') : undefined}
      body={body}
      actions={props.actions}
    >
      <DiffCodePreview diff={body} paths={props.paths} />
      {capped > 0 && (
        <p className={TOOL_OUTPUT_NOTE_CLASS}>{copy.hiddenLines(capped)}</p>
      )}
    </ToolOutputSurface>
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
    <ToolOutputSurface
      kind="terminal"
      heading={safeCmd}
      body={props.output ? shellOutputText(props.output, copy) : undefined}
      attention={props.sandboxBlocked ? 'warning' : succeeded ? undefined : 'error'}
    >
      {props.output ? (
        <ShellOutputBody output={props.output} failed={!succeeded} />
      ) : (
        <p className={TOOL_OUTPUT_NOTE_CLASS}>{copy.terminalUnavailable}</p>
      )}
      {props.failureMessage && (
        <p className={cn(TOOL_OUTPUT_NOTE_CLASS, props.sandboxBlocked ? 'maka-tool-output-warning' : 'maka-tool-output-destructive')}>
          {redactSecrets(props.failureMessage)}
        </p>
      )}
      {cancelled && (
        <p className={cn(TOOL_OUTPUT_NOTE_CLASS, 'maka-tool-output-destructive')}>
          {props.exitCode !== undefined ? `${copy.cancelled} · ${copy.exitCode(props.exitCode)}` : copy.cancelled}
        </p>
      )}
      {timedOut && !cancelled && (
        <p className={cn(TOOL_OUTPUT_NOTE_CLASS, 'maka-tool-output-destructive')}>
          {props.exitCode !== undefined ? `${copy.timedOut} · ${copy.exitCode(props.exitCode)}` : copy.timedOut}
        </p>
      )}
      {props.sandboxBlocked && !cancelled && !timedOut && (
        <p className={cn(TOOL_OUTPUT_NOTE_CLASS, 'maka-tool-output-warning')}>
          {props.exitCode !== undefined
            ? `${activityCopy.status.sandboxBlocked} · ${copy.exitCode(props.exitCode)}`
            : activityCopy.status.sandboxBlocked}
        </p>
      )}
    </ToolOutputSurface>
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
    <ToolOutputSurface
      kind="shell_run"
      heading={safeCmd}
      body={pipeOutput ? shellOutputText(pipeOutput, copy) : undefined}
      attention={attention ? (sandboxBlocked ? 'warning' : 'error') : undefined}
    >
      <p className={TOOL_OUTPUT_NOTE_CLASS}>
        {statusLabel}
        {result.exitCode !== undefined ? ` · ${copy.exitCode(result.exitCode)}` : ''}
        {safeRef ? ` · ${safeRef}` : ''}
      </p>
      {result.failureMessage && (
        <p className={cn(TOOL_OUTPUT_NOTE_CLASS, sandboxBlocked ? 'maka-tool-output-warning' : 'maka-tool-output-destructive')}>
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
    </ToolOutputSurface>
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
        'maka-pty-shell',
        props.attention && (
          props.sandboxBlocked
            ? 'maka-tool-output-warning-border'
            : 'maka-tool-output-destructive-border'
        ),
      )}
    >
      <header className="maka-pty-shell-header">
        <span className="maka-pty-shell-title">
          Shell
        </span>
      </header>
      <div className="maka-pty-shell-body">
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
          <p className={cn(TOOL_OUTPUT_NOTE_CLASS, props.sandboxBlocked ? 'maka-tool-output-warning' : 'maka-tool-output-destructive')}>
            {redactSecrets(result.failureMessage)}
          </p>
        )}
      </div>
      <footer className="maka-pty-shell-footer">
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
  if (props.source === 'owned') return <><GitBranch size={ICON_SIZE.control} aria-hidden="true" />{copy.managedBySource}</>;
  if (props.source === 'unavailable') return <><GitBranch size={ICON_SIZE.control} aria-hidden="true" />{copy.sourceUnavailable}</>;
  const suffix = props.exitCode !== undefined && props.exitCode !== 0 ? ` · ${copy.exitCode(props.exitCode)}` : '';
  if (props.sandboxBlocked) {
    return <><ShieldAlert size={ICON_SIZE.control} aria-hidden="true" />{activityCopy.status.sandboxBlocked}{suffix}</>;
  }
  switch (props.status) {
    case 'starting':
    case 'running':
      return <><Loader2 size={ICON_SIZE.control} aria-hidden="true" className="maka-spin" />{copy.running}</>;
    case 'completed':
      return <><Check size={ICON_SIZE.control} aria-hidden="true" />{copy.success}</>;
    case 'failed':
      return <><AlertCircle size={ICON_SIZE.control} aria-hidden="true" />{copy.failed}{suffix}</>;
    case 'timed_out':
      return <><Clock size={ICON_SIZE.control} aria-hidden="true" />{copy.timedOut}{suffix}</>;
    case 'cancelled':
      return <><Ban size={ICON_SIZE.control} aria-hidden="true" />{copy.cancelled}{suffix}</>;
    case 'orphaned':
      return <><Plug size={ICON_SIZE.control} aria-hidden="true" />{copy.disconnected}</>;
  }
}

/**
 * The output half of a `ToolOutputSurface` — never the command. The command is
 * the surface's header now, so this renders the same `<pre>` well the live
 * stream uses instead of its own bordered CodeBlock card, which used to nest a
 * second border inside the panel and put the command in its title slot.
 */
/**
 * The plain text a shell body renders, so the surface's copy action can offer
 * the same string the reader is looking at — capped and redacted, with the
 * per-stream "hidden lines" markers the body shows.
 *
 * The body used to be an Astryx CodeBlock, whose own copy button carried this
 * text; the panel replaced that chrome, so the text has to reach the panel's
 * button instead. One function owns it, and the body renders from the same
 * call — a copy that quietly diverged from the pixels would be worse than none.
 */
function shellOutputText(
  output: ShellOutput,
  copy: ReturnType<typeof getToolActivityCopy>['result'],
): string {
  if (output.mode === 'pty') return redactSecrets(ptyHumanTerminalText(output));
  const stdout = capLines(redactSecrets(output.stdout));
  const stderr = capLines(redactSecrets(output.stderr));
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
  return parts.join('\n');
}

function ShellOutputBody(props: {
  output: ShellOutput;
  failed: boolean;
}) {
  const copy = getToolActivityCopy(useUiLocale()).result;
  if (props.output.mode === 'pty') {
    const text = shellOutputText(props.output, copy);
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
  const code = shellOutputText(props.output, copy);
  return (
    <>
      {hasOutput
        ? <pre className={TOOL_OUTPUT_BODY_CLASS}>{code}</pre>
        : <p className={TOOL_OUTPUT_NOTE_CLASS}>{copy.noOutput}</p>}
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
      className={cn(TOOL_OUTPUT_BODY_CLASS, 'maka-pty-terminal-body')}
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

function shellRunStatusLabel(status: string, locale: import('@maka/core/ui-locale').UiLocale): string {
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
      <div className="maka-web-result" data-kind="web_search">
        <header className="maka-web-result-header">
          <strong>{redactSecrets(props.query)}</strong>
          <small>{props.provider} · {copy.webNoResults}</small>
        </header>
      </div>
    );
  }
  return (
    <div className="maka-web-result" data-kind="web_search">
      <header className="maka-web-result-header">
        <strong>{redactSecrets(props.query)}</strong>
        <small>
          {props.provider} · {copy.webResults(rows.length)}
        </small>
      </header>
      <ul className="maka-web-result-list">
        {rows.map((row, idx) => (
          <li key={`${row.url}-${idx}`}>
            <Link href={row.url} isExternalLink>
              {redactSecrets(row.title)}
            </Link>
            <small>{redactSecrets(row.source)}</small>
            <p>{redactSecrets(row.snippet)}</p>
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
    <div className="maka-web-result maka-web-result-error" data-kind="web_search_error">
      <header className="maka-web-result-header">
        <strong>{redactSecrets(props.query ?? copy.webSearch)}</strong>
        <small>{redactSecrets(props.provider)} · {copy.webFailure} · {sourceCopy}</small>
      </header>
      <p className="maka-web-result-error-message">{redactSecrets(props.message)}</p>
      <p className="maka-web-result-repair">{repairCopy}</p>
    </div>
  );
}
