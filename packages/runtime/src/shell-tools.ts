import { z } from 'zod';
import { jsonSchema, zodSchema } from 'ai';
import {
  encodedTerminalInputActionsByteLength,
  normalizeTerminalInputActionDefaults,
  parseTerminalInputAction,
  TERMINAL_INPUT_MODIFIERS,
  TERMINAL_INPUT_NAMED_KEYS,
  TERMINAL_MOUSE_BUTTONS,
  TERMINAL_MOUSE_EVENTS,
  TERMINAL_MOUSE_SCROLL_DIRECTIONS,
  type TerminalInputAction,
} from '@maka/core/terminal-input';
import { isActiveShellRunStatus } from '@maka/core/shell-run';
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
  MAX_WRITE_STDIN_ACTIONS,
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
     * the model's tool selection.
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
  const terminalAction = z.unknown().transform((value, context): TerminalInputAction => {
    try {
      return parseTerminalInputAction(value);
    } catch (error) {
      context.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : 'Invalid terminal input action',
      });
      return value as TerminalInputAction;
    }
  });
  const strictParameters = z.preprocess(
    normalizeProviderWriteStdinInput,
    z
      .object({
        ref: z
          .string()
          .max(MAX_SHELL_RUN_RESOURCE_REF_CHARS)
          .refine(isShellRunResourceRef, 'ref must be a canonical PTY Bash runtime ref'),
        input: z
          .string()
          .min(1, 'input must not be empty')
          .refine(isWellFormedTerminalInput, 'input must be well-formed Unicode')
          .refine(
            (value) => Buffer.byteLength(value, 'utf8') <= MAX_WRITE_STDIN_INPUT_BYTES,
            `input must not exceed ${MAX_WRITE_STDIN_INPUT_BYTES} bytes`,
          )
          .optional(),
        actions: z.array(terminalAction).min(1).max(MAX_WRITE_STDIN_ACTIONS).optional(),
        size: z
          .object({
            cols: z.number().int().min(MIN_PTY_COLS).max(MAX_PTY_COLS),
            rows: z.number().int().min(MIN_PTY_ROWS).max(MAX_PTY_ROWS),
          })
          .strict()
          .optional(),
      })
      .strict()
      .refine((value) => value.input === undefined || value.actions === undefined, {
        message: 'raw input and terminal actions are mutually exclusive',
      })
      .refine(
        (value) =>
          value.input !== undefined || value.actions !== undefined || value.size !== undefined,
        {
          message: 'input, actions, and/or size is required',
        },
      )
      .superRefine((value, context) => {
        if (!value.actions) return;
        try {
          if (encodedTerminalInputActionsByteLength(value.actions) > MAX_WRITE_STDIN_INPUT_BYTES) {
            context.addIssue({
              code: 'custom',
              path: ['actions'],
              message: `actions must not exceed ${MAX_WRITE_STDIN_INPUT_BYTES} encoded bytes`,
            });
          }
        } catch {
          // The key action reports its own precise validation issue.
        }
      }),
  );
  const providerAction = z
    .object({
      type: z.enum(['text', 'key', 'mouse']).describe('Action kind'),
      text: z
        .string()
        .describe('Visible text for a text action; omit it for a key action')
        .optional(),
      key: z
        .string()
        .describe(
          `Named key (${TERMINAL_INPUT_NAMED_KEYS.join(', ')}) or one printable ASCII character for a key action; omit it for a text action`,
        )
        .optional(),
      event: z
        .enum(TERMINAL_MOUSE_EVENTS)
        .describe('Mouse event; omit it for text and key actions')
        .optional(),
      x: z
        .number()
        .int()
        .min(0)
        .describe('Zero-based terminal cell column for a mouse action')
        .optional(),
      y: z
        .number()
        .int()
        .min(0)
        .describe('Zero-based terminal cell row for a mouse action')
        .optional(),
      button: z
        .enum(TERMINAL_MOUSE_BUTTONS)
        .describe('Mouse button; required for click, press, and release')
        .optional(),
      direction: z
        .enum(TERMINAL_MOUSE_SCROLL_DIRECTIONS)
        .describe('Scroll direction; required only for scroll')
        .optional(),
      modifiers: z
        .array(z.enum(TERMINAL_INPUT_MODIFIERS))
        .describe('Optional unique modifiers for a key or mouse action')
        .optional(),
    })
    .strict();
  const providerParameters = z
    .object({
      ref: z
        .string()
        .max(MAX_SHELL_RUN_RESOURCE_REF_CHARS)
        .describe('The runtime ref returned by a PTY Bash task'),
      actions: z
        .array(providerAction)
        .max(MAX_WRITE_STDIN_ACTIONS)
        .describe(
          'Ordered terminal input actions. Text uses type and text. Key uses type, key, and optional modifiers. Mouse uses type, event, zero-based x/y, event-specific button or direction, and optional modifiers. Omit it for a resize-only call.',
        )
        .optional(),
      size: z
        .object({
          cols: z.number().describe('Terminal columns').optional(),
          rows: z.number().describe('Terminal rows').optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .describe('Send ordered terminal actions and/or resize a background PTY');
  const providerSchema = zodSchema(providerParameters);
  const parameters = jsonSchema(async () => await providerSchema.jsonSchema, {
    validate: async (value) => {
      const result = await strictParameters.safeParseAsync(value);
      return result.success
        ? { success: true, value: result.data }
        : { success: false, error: result.error };
    },
  });
  const parseInput = (value: unknown) => strictParameters.parse(value);
  return {
    name: 'WriteStdin',
    activityKind: 'command',
    description:
      'Send an ordered sequence of text, key, and mouse actions to a background PTY and/or resize it, then return the terminal state at the next parser cut. ' +
      `Named keys are ${TERMINAL_INPUT_NAMED_KEYS.join(', ')}. Use a printable ASCII key with ctrl or alt for chords such as Ctrl-B; use text for ordinary typing. ` +
      'Mouse coordinates are zero-based terminal cells and work only while the application has enabled SGR cell mouse reporting. ' +
      'Actions are written atomically in their listed order. Text is ordinary audited tool-call data, not a secure secret channel. ' +
      'The returned output is the terminal state at that cut, not output attributed to this input; use Read on the ref to observe later output.',
    parameters,
    permissionArgs: (input) => parseInput(input),
    impl: (input, ctx) => {
      const { ref, input: rawInput, actions, size } = parseInput(input);
      return ptyControls.writeStdin({
        sessionId: ctx.sessionId,
        ref,
        ...(rawInput !== undefined ? { input: rawInput } : {}),
        ...(actions !== undefined ? { actions } : {}),
        ...(size !== undefined ? { size } : {}),
        abortSignal: ctx.abortSignal,
      });
    },
  };
}

function normalizeProviderWriteStdinInput(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const normalized = { ...(value as Record<string, unknown>) };
  if (normalized.actions === null || isEmptyArray(normalized.actions)) {
    delete normalized.actions;
  } else if (Array.isArray(normalized.actions)) {
    normalized.actions = normalized.actions.map(normalizeTerminalInputActionDefaults);
  }
  if (normalized.size === null || isEmptyProviderSize(normalized.size)) delete normalized.size;
  return normalized;
}

function isEmptyArray(value: unknown): value is [] {
  return Array.isArray(value) && value.length === 0;
}

function isEmptyProviderSize(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return (
    entries.every(([key]) => key === 'cols' || key === 'rows') &&
    entries.every(([, field]) => field === undefined || field === null || field === 0)
  );
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
