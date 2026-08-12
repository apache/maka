import { z } from 'zod';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import {
  buildRiveCommand,
  redactRiveText,
  runRiveCli,
  RiveCliError,
  type RiveCliAction,
  type RiveCliToolArgs,
} from './rive-cli.js';

export const RIVE_WORKFLOW_TOOL_NAME = 'RiveWorkflow';

const actionSchema = z.enum([
  'workflow_validate',
  'workflow_import',
  'workflow_run',
  'workflow_status',
  'scheduler_status',
  'scheduler_resume',
  'work_retry',
  'branch_conflict_show',
] satisfies [RiveCliAction, ...RiveCliAction[]]);

const riveToolParameters = z.object({
  action: actionSchema.describe(
    'High-level Rive operation. Prefer workflow_run/status, scheduler_status/resume, and work_retry over low-level ledger commands.',
  ),
  path: z.string().min(1).max(2000).optional().describe('Workflow package path for validate/import.'),
  templateId: z.string().min(1).max(240).optional().describe('Workflow template id for workflow_run.'),
  workflowRunId: z.string().min(1).max(240).optional().describe('workflow_run_id for workflow_status.'),
  schedulerRunId: z.string().min(1).max(240).optional().describe('scheduler_run_id for scheduler_status/resume.'),
  rootWorkNodeId: z.string().min(1).max(240).optional().describe('root work node id for scheduler_status/resume.'),
  workNodeId: z.string().min(1).max(240).optional().describe('work_node_id for work_retry.'),
  conflictId: z.string().min(1).max(240).optional().describe('branch conflict id for branch_conflict_show.'),
  commandId: z.string().min(1).max(240).optional().describe('Stable idempotency command id. Required for mutating/run actions.'),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
    .describe('Workflow params as key/value pairs. Maka passes them to Rive as repeated --param key=value arguments.'),
  bumpIfChanged: z.boolean().optional(),
  noScheduler: z.boolean().optional(),
  runner: z.enum(['opencode', 'codex']).optional(),
  workers: z.array(z.string().min(1).max(200)).max(20).optional(),
  maxParallel: z.number().int().positive().max(20).optional(),
  acceptanceMode: z.enum(['manual', 'auto-reported', 'auto-committed']).optional(),
  workspaceMode: z.enum(['shared', 'worktree']).optional(),
  opencodeBin: z.string().min(1).max(2000).optional(),
  codexBin: z.string().min(1).max(2000).optional(),
  trustProject: z.boolean().optional(),
  failed: z.boolean().optional().describe('For scheduler_resume, retry only failed/stale attempts.'),
  timeoutSeconds: z.number().int().positive().max(60 * 60).optional(),
  timeoutMs: z.number().int().positive().max(60 * 60 * 1000).optional()
    .describe('Maka-side subprocess timeout. Defaults to 10 minutes.'),
});

export type RiveWorkflowToolArgs = z.infer<typeof riveToolParameters>;

export interface RiveWorkflowToolResult {
  kind: 'rive_workflow';
  ok: boolean;
  action: RiveCliAction;
  command: string[];
  state?: string;
  ids: {
    workflowRunId?: string;
    schedulerRunId?: string;
    rootWorkNodeId?: string;
  };
  summary: string;
  projection?: RiveWorkflowProjection;
  nodes?: RiveWorkflowNodeSummary[];
  stdoutTail?: string;
  stderrTail?: string;
  error?: {
    reason: string;
    message: string;
    code?: string;
    suggestedAction?: string;
  };
}

interface RiveWorkflowProjection {
  templateId?: string;
  version?: number;
  templateHash?: string;
  idempotencyStatus?: string;
  workflowRunId?: string;
  schedulerRunId?: string;
  rootWorkNodeId?: string;
  state?: string;
  schedulerState?: string;
  rootState?: string;
}

interface RiveWorkflowNodeSummary {
  id?: string;
  templateId?: string;
  title?: string;
  state?: string;
  runner?: string;
  worker?: string;
}

export function buildRiveWorkflowTool(deps: {
  riveBin?: string;
  env?: NodeJS.ProcessEnv;
} = {}): MakaTool<RiveWorkflowToolArgs, RiveWorkflowToolResult> {
  return {
    name: RIVE_WORKFLOW_TOOL_NAME,
    displayName: 'Rive 工作流',
    description:
      'Use Rive to run or inspect durable multi-agent workflows from the current workspace. ' +
      'This tool calls high-level Rive CLI commands only: workflow validate/import/run/status, scheduler status/resume, work retry, and conflict inspection. ' +
      'Rive remains the source of truth for workflow state; judge success only from Rive protocol projections, never stdout, final answers, or debug traces. ' +
      'Use this when a task benefits from a reusable workflow, parallel workers, retry/recovery, or ledger-backed artifact refs.',
    parameters: riveToolParameters,
    categoryHint: 'custom_tool',
    impl: async (args, { cwd, abortSignal, emitOutput }) => {
      let command: string[];
      try {
        command = [
          deps.riveBin ?? deps.env?.MAKA_RIVE_BIN ?? deps.env?.RIVE_BIN ?? process.env.MAKA_RIVE_BIN ?? process.env.RIVE_BIN ?? 'rive',
          ...buildRiveCommand(args),
        ];
      } catch (error) {
        return failureResult(args.action, [], errorToReason(error), errorMessage(error));
      }
      emitOutput('stdout', `$ ${command.map(displayArg).join(' ')}\n`);
      try {
        const result = await runRiveCli(args, {
          cwd,
          riveBin: deps.riveBin,
          env: deps.env ?? process.env,
          abortSignal,
          timeoutMs: args.timeoutMs,
          emitOutput,
        });
        return successResult(args.action, result.command, result.envelope, result.stdoutTail, result.stderrTail);
      } catch (error) {
        if (error instanceof RiveCliError) {
          return failureResult(args.action, error.command ?? command, error.reason, error.message, error);
        }
        return failureResult(args.action, command, 'process_error', errorMessage(error));
      }
    },
  };
}

function successResult(
  action: RiveCliAction,
  command: string[],
  envelope: unknown,
  stdoutTail: string,
  stderrTail: string,
): RiveWorkflowToolResult {
  const protocol = readEnvelopeField(envelope, 'protocol');
  const display = readEnvelopeField(envelope, 'display');
  const projection = extractProjection(protocol);
  return {
    kind: 'rive_workflow',
    ok: true,
    action,
    command: redactCommand(command),
    state: projection.state,
    ids: extractIds(projection),
    summary: extractSummary(display, protocol, 'Rive command completed.'),
    projection,
    nodes: extractNodeSummaries(protocol),
    stdoutTail,
    stderrTail,
  };
}

function failureResult(
  action: RiveCliAction,
  command: string[],
  reason: string,
  message: string,
  error?: RiveCliError,
): RiveWorkflowToolResult {
  const protocol = error?.envelope ? readEnvelopeField(error.envelope, 'protocol') : undefined;
  const projection = extractProjection(protocol);
  const errorEnvelope = error?.envelope && typeof error.envelope === 'object'
    ? (error.envelope as { error?: { code?: unknown; action?: unknown } }).error
    : undefined;
  return {
    kind: 'rive_workflow',
    ok: false,
    action,
    command: redactCommand(command),
    state: projection.state,
    ids: extractIds(projection),
    summary: message,
    projection,
    nodes: extractNodeSummaries(protocol),
    stdoutTail: error?.stdoutTail ? redactRiveText(error.stdoutTail) : undefined,
    stderrTail: error?.stderrTail ? redactRiveText(error.stderrTail) : undefined,
    error: {
      reason,
      message,
      ...(typeof errorEnvelope?.code === 'string' ? { code: errorEnvelope.code } : {}),
      ...(typeof errorEnvelope?.action === 'string' ? { suggestedAction: errorEnvelope.action } : {}),
    },
  };
}

function extractIds(projection: RiveWorkflowProjection): RiveWorkflowToolResult['ids'] {
  return {
    ...(projection.workflowRunId ? { workflowRunId: projection.workflowRunId } : {}),
    ...(projection.schedulerRunId ? { schedulerRunId: projection.schedulerRunId } : {}),
    ...(projection.rootWorkNodeId ? { rootWorkNodeId: projection.rootWorkNodeId } : {}),
  };
}

function extractState(protocol: unknown): string | undefined {
  if (!protocol || typeof protocol !== 'object') return undefined;
  const obj = protocol as Record<string, unknown>;
  if (typeof obj.state === 'string') return obj.state;
  const scheduler = obj.scheduler && typeof obj.scheduler === 'object' ? obj.scheduler as Record<string, unknown> : undefined;
  if (typeof scheduler?.state === 'string') return scheduler.state;
  return undefined;
}

function extractProjection(protocol: unknown): RiveWorkflowProjection {
  if (!protocol || typeof protocol !== 'object') return {};
  const obj = protocol as Record<string, unknown>;
  const scheduler = obj.scheduler && typeof obj.scheduler === 'object' ? obj.scheduler as Record<string, unknown> : undefined;
  const rootWork = obj.root_work && typeof obj.root_work === 'object' ? obj.root_work as Record<string, unknown> : undefined;
  const rootProjection = obj.root_projection && typeof obj.root_projection === 'object' ? obj.root_projection as Record<string, unknown> : undefined;
  const projection: RiveWorkflowProjection = {
    ...(typeof obj.template_id === 'string' ? { templateId: obj.template_id } : {}),
    ...(typeof obj.version === 'number' ? { version: obj.version } : {}),
    ...(typeof obj.template_hash === 'string' ? { templateHash: obj.template_hash } : {}),
    ...(typeof obj.idempotency_status === 'string' ? { idempotencyStatus: obj.idempotency_status } : {}),
    ...(typeof obj.workflow_run_id === 'string' ? { workflowRunId: obj.workflow_run_id } : {}),
    ...(typeof obj.scheduler_run_id === 'string' ? { schedulerRunId: obj.scheduler_run_id } : {}),
    ...(typeof scheduler?.scheduler_run_id === 'string' ? { schedulerRunId: scheduler.scheduler_run_id } : {}),
    ...(typeof obj.root_work_node_id === 'string' ? { rootWorkNodeId: obj.root_work_node_id } : {}),
    ...(typeof scheduler?.root_work_node_id === 'string' ? { rootWorkNodeId: scheduler.root_work_node_id } : {}),
    ...(typeof obj.state === 'string' ? { state: obj.state } : {}),
    ...(typeof scheduler?.state === 'string' ? { schedulerState: scheduler.state } : {}),
    ...(typeof rootWork?.state === 'string' ? { rootState: rootWork.state } : {}),
    ...(typeof rootProjection?.state === 'string' ? { rootState: rootProjection.state } : {}),
  };
  if (!projection.state) {
    projection.state = projection.schedulerState ?? projection.rootState ?? extractState(protocol);
  }
  return projection;
}

function extractNodeSummaries(protocol: unknown): RiveWorkflowNodeSummary[] | undefined {
  if (!protocol || typeof protocol !== 'object') return undefined;
  const obj = protocol as Record<string, unknown>;
  const rawNodes = Array.isArray(obj.nodes)
    ? obj.nodes
    : Array.isArray(obj.workflow_run_nodes)
      ? obj.workflow_run_nodes
      : Array.isArray(obj.node_mapping)
        ? obj.node_mapping
        : [];
  const nodes = rawNodes
    .slice(0, 20)
    .map((node): RiveWorkflowNodeSummary => {
      if (!node || typeof node !== 'object') return {};
      const value = node as Record<string, unknown>;
      return {
        ...(typeof value.work_node_id === 'string' ? { id: value.work_node_id } : {}),
        ...(typeof value.id === 'string' ? { id: value.id } : {}),
        ...(typeof value.node_template_id === 'string' ? { templateId: value.node_template_id } : {}),
        ...(typeof value.template_id === 'string' ? { templateId: value.template_id } : {}),
        ...(typeof value.title === 'string' ? { title: value.title } : {}),
        ...(typeof value.state === 'string' ? { state: value.state } : {}),
        ...(typeof value.runner === 'string' ? { runner: value.runner } : {}),
        ...(typeof value.worker === 'string' ? { worker: value.worker } : {}),
      };
    })
    .filter((node) => Object.keys(node).length > 0);
  return nodes.length > 0 ? nodes : undefined;
}

function extractSummary(display: unknown, protocol: unknown, fallback: string): string {
  if (display && typeof display === 'object' && typeof (display as { summary?: unknown }).summary === 'string') {
    return (display as { summary: string }).summary;
  }
  const state = extractState(protocol);
  return state ? `Rive command completed with state ${state}.` : fallback;
}

function readEnvelopeField(envelope: unknown, field: 'protocol' | 'display'): unknown {
  if (!envelope || typeof envelope !== 'object') return undefined;
  return (envelope as Record<string, unknown>)[field];
}

function errorToReason(error: unknown): string {
  return error instanceof RiveCliError ? error.reason : 'invalid_arguments';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function displayArg(value: string): string {
  const redacted = redactRiveText(value);
  return /^[A-Za-z0-9_./:@=-]+$/.test(redacted) ? redacted : JSON.stringify(redacted);
}

function redactCommand(command: string[]): string[] {
  return command.map((part) => redactRiveText(part));
}
