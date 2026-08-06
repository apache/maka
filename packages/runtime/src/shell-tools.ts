import { z } from 'zod';
import { isActiveShellRunStatus } from '@maka/core';
import { redactSecrets } from '@maka/core/redaction';
import type { ToolResultContent } from '@maka/core/events';
import type { ToolExecutionFacts } from '@maka/core/permission';
import type { SandboxBoundaryExpansion } from '@maka/core/sandbox-boundary';
import type { MakaTool, MakaToolContext } from './tool-runtime.js';
import type { SandboxType } from './sandbox/types.js';
import { isLikelySandboxDenial } from './sandbox/detect.js';
import { runShellWithBoundedTail, type BoundedShellResult } from './shell-exec.js';
import { bashToolShellGuidance, defaultShellPlan, type ShellPlan } from './shell-detect.js';
import { truncateToolOutput } from './tool-output.js';
import {
  DEFAULT_BASH_TIMEOUT_MS,
  MAX_PTY_COLS,
  MAX_PTY_ROWS,
  MAX_FOREGROUND_BASH_TIMEOUT_MS,
  MAX_SHELL_RUN_RESOURCE_REF_CHARS,
  MAX_SHELL_RUN_TIMEOUT_MS,
  MAX_WRITE_STDIN_INPUT_BYTES,
  MIN_PTY_COLS,
  MIN_PTY_ROWS,
  type BackgroundTaskStopper,
  type PtyControlWriter,
  type ShellRunBashInput,
  isShellRunResourceRef,
  isWellFormedTerminalInput,
} from './shell-run-contract.js';
import type { ChildFdInput } from './child-fd-input.js';
import { bashToolResultToModelOutput } from './bash-model-output.js';
import {
  preflightDeclaredSandboxBoundary,
  sandboxBoundaryExpansionSchema,
} from './sandbox-boundary-declaration.js';

export interface ForegroundBashExecuteInput {
  command: string;
  cwd: string;
  timeoutMs?: number;
  ctx: MakaToolContext;
}

export interface ForegroundBashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  timedOut?: boolean;
  aborted?: boolean;
  sandboxType?: SandboxType;
  sandboxed?: boolean;
}

export interface BuildForegroundBashToolOptions {
  description: string;
  executionFacts?: ToolExecutionFacts;
  defaultTimeoutMs?: (command: string) => number | undefined;
  maxTimeoutMs?: number;
  emitReturnedOutput?: boolean;
  execute: (input: ForegroundBashExecuteInput) => Promise<ForegroundBashResult>;
  afterResult?: (
    input: { command: string; cwd: string; timeoutMs?: number },
    result: ForegroundBashResult,
    ctx: MakaToolContext,
  ) => Promise<void> | void;
}

type TerminalToolResult = Extract<ToolResultContent, { kind: 'terminal' }>;
type ShellRunToolResult = Extract<ToolResultContent, { kind: 'shell_run' }>;

export interface ShellRunLauncher {
  runForegroundBash(input: ShellRunBashInput): Promise<TerminalToolResult>;
  runBackgroundBash(input: ShellRunBashInput): Promise<ShellRunToolResult>;
}

export function buildForegroundBashTool(options: BuildForegroundBashToolOptions): MakaTool {
  const maxTimeoutMs = options.maxTimeoutMs ?? 600_000;
  return {
    name: 'Bash',
    activityKind: 'command',
    description: options.description,
    parameters: z.object({
      command: z.string().describe('The shell command to execute'),
      timeout_ms: z.number().int().positive().max(maxTimeoutMs).optional(),
    }),
    toModelOutput: ({ output }) => bashToolResultToModelOutput(output),
    ...(options.executionFacts ? { executionFacts: options.executionFacts } : {}),
    impl: async ({ command, timeout_ms }, ctx) => {
      const timeoutMs = timeout_ms ?? options.defaultTimeoutMs?.(command);
      const result = await options.execute({ command, cwd: ctx.cwd, timeoutMs, ctx });
      if (options.emitReturnedOutput) {
        if (result.stdout) ctx.emitOutput('stdout', result.stdout);
        if (result.stderr) ctx.emitOutput('stderr', result.stderr);
      }
      await options.afterResult?.(
        { command, cwd: ctx.cwd, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
        result,
        ctx,
      );
      return shapeTerminalResult({
        cwd: ctx.cwd,
        command,
        result,
      });
    },
  };
}

export function buildLocalForegroundBashTool(
  options: { executionFacts?: ToolExecutionFacts; shell?: ShellPlan } = {},
): MakaTool {
  const shell = options.shell ?? defaultShellPlan();
  return buildForegroundBashTool({
    description:
      withShellGuidance('Run a shell command in the session cwd.', shell) +
      ' Subject to permission policy.',
    ...(options.executionFacts ? { executionFacts: options.executionFacts } : {}),
    defaultTimeoutMs: () => 120_000,
    execute: async ({ command, cwd, timeoutMs, ctx }) =>
      runShellWithBoundedTail(command, {
        cwd,
        timeoutMs: timeoutMs ?? 120_000,
        abortSignal: ctx.abortSignal,
        emitOutput: ctx.emitOutput,
        shell,
      }),
  });
}

export function buildManagedBashTool(
  shellRuns: ShellRunLauncher,
  options: {
    executionFacts?: ToolExecutionFacts;
    shell?: ShellPlan;
    /** Opening sentence of the description, before the shared foreground/background/PTY contract. */
    lead?: string;
    /**
     * Whether this host has a sandbox boundary the model can be asked to declare.
     * False drops `required_boundary` from the schema entirely rather than
     * accepting and ignoring it: a parameter no host enforces is pure noise in
     * the model's tool selection. Headless runs inside an external isolation
     * boundary with no in-process sandbox manager, so it passes false.
     */
    declareSandboxBoundary?: boolean;
    /**
     * Foreground timeout when the model does not ask for one, per command —
     * the same hook shape buildForegroundBashTool exposes, so a host that
     * carves out a slow command keeps that carve-out on both paths instead of
     * re-implementing it on one.
     *
     * A host default is CLAMPED to MAX_FOREGROUND_BASH_TIMEOUT_MS rather than
     * passed through: the launcher REJECTS anything larger, so an operator who
     * raised their own floor past ten minutes would otherwise break every
     * foreground command instead of merely capping it. A timeout the model asks
     * for explicitly is still rejected above the maximum — that is a stated
     * schema bound, not a host misconfiguration.
     */
    defaultTimeoutMs?: (command: string) => number | undefined;
    /** Observes each committed result; used by hosts that record tool evidence. */
    afterResult?: (
      input: { command: string; cwd: string; timeoutMs?: number },
      result: TerminalToolResult | ShellRunToolResult,
      ctx: MakaToolContext,
    ) => Promise<void> | void;
    transformCommand?: (input: {
      command: string;
      pty: boolean;
      requiredBoundary?: SandboxBoundaryExpansion;
      ctx: MakaToolContext;
    }) =>
      | {
          argv?: readonly string[];
          cwd: string;
          env?: NodeJS.ProcessEnv;
          fdInputs?: readonly ChildFdInput[];
          sandboxType?: SandboxType;
          onCompletion?: (outcome: { successful: boolean }) => void;
        }
      | undefined;
  } = {},
): MakaTool {
  const shell = options.shell ?? defaultShellPlan();
  const declareSandboxBoundary = options.declareSandboxBoundary !== false;
  const managedBashFields = {
    command: z.string().describe('The shell command to execute'),
    timeout_ms: z.number().int().positive().max(MAX_SHELL_RUN_TIMEOUT_MS).optional(),
    run_in_background: z.boolean().optional(),
    pty: z.boolean().optional(),
  };
  const refineManagedBash = (
    { timeout_ms, run_in_background, pty }: z.infer<z.ZodObject<typeof managedBashFields>>,
    ctx: z.core.$RefinementCtx,
  ) => {
    if (
      !run_in_background &&
      timeout_ms !== undefined &&
      timeout_ms > MAX_FOREGROUND_BASH_TIMEOUT_MS
    ) {
      ctx.addIssue({
        code: 'too_big',
        maximum: MAX_FOREGROUND_BASH_TIMEOUT_MS,
        origin: 'number',
        inclusive: true,
        path: ['timeout_ms'],
        message: `Foreground Bash timeout may not exceed ${MAX_FOREGROUND_BASH_TIMEOUT_MS}ms`,
      });
    }
    if (pty && !run_in_background) {
      ctx.addIssue({
        code: 'custom',
        path: ['pty'],
        message: 'PTY Bash requires run_in_background=true',
      });
    }
  };
  return {
    name: 'Bash',
    activityKind: 'command',
    description:
      withShellGuidance(options.lead ?? 'Run a shell command in the session cwd.', shell) +
      ` Foreground is the default (timeout ${DEFAULT_BASH_TIMEOUT_MS}ms, maximum ${MAX_FOREGROUND_BASH_TIMEOUT_MS}ms).` +
      ` Set run_in_background=true only when the command should continue as a tracked runtime background task; background commands have no default timeout (maximum explicit timeout ${MAX_SHELL_RUN_TIMEOUT_MS}ms).` +
      ' Set pty=true together with run_in_background=true only for terminal semantics or later input; use the returned ref with Read or WriteStdin.' +
      (declareSandboxBoundary ? ' Enforced by the current session sandbox boundary.' : ''),
    parameters: declareSandboxBoundary
      ? z
          .object({
            ...managedBashFields,
            required_boundary: sandboxBoundaryExpansionSchema
              .optional()
              .describe(
                'Declare the exact filesystem or network sandbox authority this command requires. Do not infer it from command text.',
              ),
          })
          .strict()
          .superRefine(refineManagedBash)
      : z.object(managedBashFields).strict().superRefine(refineManagedBash),
    toModelOutput: ({ output }) => bashToolResultToModelOutput(output),
    ...(options.executionFacts ? { executionFacts: options.executionFacts } : {}),
    impl: async (input, ctx) => {
      const { command, timeout_ms, run_in_background, pty } = input;
      const normalizedRequiredBoundary = await preflightDeclaredSandboxBoundary(
        'required_boundary' in input ? input.required_boundary : undefined,
        ctx,
      );
      const transformed = options.transformCommand?.({
        command,
        pty: pty === true,
        ...(normalizedRequiredBoundary ? { requiredBoundary: normalizedRequiredBoundary } : {}),
        ctx,
      });
      const onCompletion = onceCompletion(transformed?.onCompletion);
      const timeoutMs =
        timeout_ms ??
        (run_in_background
          ? undefined
          : clampHostForegroundTimeout(options.defaultTimeoutMs?.(command)));
      try {
        const result = await shellRuns[
          run_in_background ? 'runBackgroundBash' : 'runForegroundBash'
        ]({
          sessionId: ctx.sessionId,
          ...(ctx.runId ? { sourceRunId: ctx.runId } : {}),
          sourceTurnId: ctx.turnId,
          sourceToolCallId: ctx.toolCallId,
          cwd: transformed?.cwd ?? ctx.cwd,
          command,
          ...(pty !== undefined ? { pty } : {}),
          ...(transformed?.argv ? { argv: transformed.argv } : { shell }),
          ...(transformed?.env ? { env: transformed.env } : {}),
          ...(transformed?.fdInputs ? { fdInputs: transformed.fdInputs } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          abortSignal: ctx.abortSignal,
          emitOutput: ctx.emitOutput,
          ...(transformed?.sandboxType ? { sandboxType: transformed.sandboxType } : {}),
          ...(onCompletion ? { onCompletion } : {}),
        });
        if (result.kind === 'terminal' || !isActiveShellRunStatus(result.status)) {
          onCompletion?.({
            successful: result.status === 'completed' && result.exitCode === 0,
          });
        }
        await options.afterResult?.(
          {
            command,
            cwd: transformed?.cwd ?? ctx.cwd,
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          },
          result,
          ctx,
        );
        return result;
      } catch (error) {
        onCompletion?.({ successful: false });
        throw error;
      }
    },
  };
}

function clampHostForegroundTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Math.min(value, MAX_FOREGROUND_BASH_TIMEOUT_MS);
}

function onceCompletion(
  callback: ((outcome: { successful: boolean }) => void) | undefined,
): ((outcome: { successful: boolean }) => void) | undefined {
  if (!callback) return undefined;
  let completed = false;
  return (outcome) => {
    if (completed) return;
    completed = true;
    callback(outcome);
  };
}

export function withShellGuidance(lead: string, shell: ShellPlan): string {
  const guidance = bashToolShellGuidance(shell);
  return guidance ? `${lead} ${guidance}` : lead;
}

export function buildStopBackgroundTaskTool(backgroundTasks: BackgroundTaskStopper): MakaTool {
  return {
    name: 'StopBackgroundTask',
    activityKind: 'command',
    description:
      'Stop a background task by runtime ref. Currently supports background shell run refs returned by Bash and shown in the turn tail.',
    parameters: z.object({
      ref: z
        .string()
        .describe(
          'The runtime background task ref, for example maka://runtime/background-tasks/<id>',
        ),
    }),
    impl: ({ ref }, ctx) => backgroundTasks.stopBackgroundTask(ctx.sessionId, ref, ctx.abortSignal),
  };
}

export function buildWriteStdinTool(ptyControls: PtyControlWriter): MakaTool {
  const parameters = z
    .object({
      ref: z
        .string()
        .max(MAX_SHELL_RUN_RESOURCE_REF_CHARS)
        .refine(isShellRunResourceRef, 'ref must be a canonical PTY Bash runtime ref')
        .describe('The runtime ref returned by a PTY Bash task'),
      input: z
        .string()
        .refine(
          (value) => value.length > 0,
          'input must not be empty; omit it for a resize-only call',
        )
        .refine(isWellFormedTerminalInput, 'input must be well-formed Unicode')
        .refine(
          (value) => Buffer.byteLength(value, 'utf8') <= MAX_WRITE_STDIN_INPUT_BYTES,
          `input must not exceed ${MAX_WRITE_STDIN_INPUT_BYTES} UTF-8 bytes`,
        )
        .optional(),
      size: z
        .object({
          cols: z.number().int().min(MIN_PTY_COLS).max(MAX_PTY_COLS),
          rows: z.number().int().min(MIN_PTY_ROWS).max(MAX_PTY_ROWS),
        })
        .strict()
        .optional(),
    })
    .strict()
    .refine((value) => value.input !== undefined || value.size !== undefined, {
      message: 'input and/or size is required',
    });
  return {
    name: 'WriteStdin',
    activityKind: 'command',
    description:
      'Send exact characters to a background PTY and/or resize it, then return the terminal state at the next parser cut. ' +
      'No newline is added: use \\r for Enter and \\u0003 for Ctrl-C. Input is ordinary audited tool-call data, not a secure secret channel. ' +
      'The returned output is the terminal state at that cut, not output attributed to this input; use Read on the ref to observe later output.',
    parameters,
    impl: ({ ref, input, size }, ctx) =>
      ptyControls.writeStdin({
        sessionId: ctx.sessionId,
        ref,
        ...(input !== undefined ? { input } : {}),
        ...(size !== undefined ? { size } : {}),
        abortSignal: ctx.abortSignal,
      }),
  };
}

export function shapeTerminalResult(input: {
  cwd: string;
  command: string;
  result: ForegroundBashResult | BoundedShellResult;
}): TerminalToolResult {
  const stdout = redactSecrets(input.result.stdout);
  const stderr = redactSecrets(input.result.stderr);
  const stdoutView = truncateToolOutput(stdout, { direction: 'tail' });
  const stderrView = truncateToolOutput(stderr, { direction: 'tail' });
  return {
    kind: 'terminal',
    cwd: input.cwd,
    cmd: redactSecrets(input.command),
    status: terminalStatus(input.result),
    exitCode: input.result.exitCode,
    output: {
      mode: 'pipes',
      stdout: stdoutView.content,
      stderr: stderrView.content,
      stdoutTruncated: Boolean(input.result.stdoutTruncated) || stdoutView.truncated,
      stderrTruncated: Boolean(input.result.stderrTruncated) || stderrView.truncated,
      redacted: stdout !== input.result.stdout || stderr !== input.result.stderr,
    },
    ...(isLikelySandboxDenial({
      stdout: input.result.stdout,
      stderr: input.result.stderr,
      sandboxed: 'sandboxed' in input.result && input.result.sandboxed === true,
    })
      ? {
          sandboxDenial: {
            likely: true,
            ...('sandboxType' in input.result &&
            (input.result.sandboxType === 'macos-seatbelt' || input.result.sandboxType === 'linux')
              ? { backend: input.result.sandboxType }
              : {}),
          },
        }
      : {}),
  };
}

function terminalStatus(
  result: ForegroundBashResult | BoundedShellResult,
): TerminalToolResult['status'] {
  if (result.timedOut) return 'timed_out';
  if (result.aborted) return 'cancelled';
  return result.exitCode === 0 ? 'completed' : 'failed';
}
