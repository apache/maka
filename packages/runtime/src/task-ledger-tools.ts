import { z } from 'zod';
import {
  TASK_STATUSES,
  TASK_EVIDENCE_MAX_CHARS,
  TASK_SUBJECT_MAX_CHARS,
  TASK_LEDGER_MAX_TASKS,
  TASK_ID_MAX_CHARS,
  filterModelVisibleTaskLedgerTasks,
  isSafeTaskId,
  isTerminalTaskStatus,
  renderSafeTaskLedgerText,
  type TaskLedgerStore,
} from '@maka/core/task-ledger';
import type { MakaTool } from './tool-runtime.js';

export const TASK_CREATE_TOOL_NAME = 'task_create';
export const TASK_UPDATE_TOOL_NAME = 'task_update';
export const TASK_LIST_TOOL_NAME = 'task_list';
export const TASK_GET_TOOL_NAME = 'task_get';

export function buildTaskLedgerTools(deps: { store: TaskLedgerStore }): MakaTool[] {
  return [
    buildTaskCreateTool(deps.store, TASK_CREATE_TOOL_NAME, 'task_update'),
    buildTaskUpdateTool(deps.store, TASK_UPDATE_TOOL_NAME),
    buildTaskListTool(deps.store),
    buildTaskGetTool(deps.store),
  ];
}

function buildTaskCreateTool(
  store: TaskLedgerStore,
  name: string,
  updateToolName: string,
): MakaTool<{ tasks: Array<{ subject: string; parent_id?: string }> }, string> {
  return {
    name,
    displayName: 'Task Create',
    description:
      'Add one or more tasks to the session task ledger. The full updated ledger is re-shown each turn, ' +
      `so use this to record work you plan to do; update status with ${updateToolName} as you progress.`,
    parameters: z.object({
      tasks: z
        .array(
          z.object({
            subject: z
              .string()
              .trim()
              .min(1)
              .max(TASK_SUBJECT_MAX_CHARS)
              .describe(
                `Short imperative description of the task (max ${TASK_SUBJECT_MAX_CHARS} characters).`,
              ),
            parent_id: z
              .string()
              .min(1)
              .max(TASK_ID_MAX_CHARS)
              .refine(isSafeTaskId)
              .optional()
              .describe('Existing parent task UUID or short key (for example T1).'),
          }),
        )
        .min(1)
        .max(TASK_LEDGER_MAX_TASKS)
        .describe('One or more tasks to add. Each starts in the pending state.'),
    }),
    impl: async (input, ctx) => {
      const { created, total } = await store.create(
        ctx.sessionId,
        input.tasks.map((task) => ({
          subject: task.subject,
          ...(task.parent_id ? { parentId: task.parent_id } : {}),
        })),
        {
          runId: ctx.runId,
          turnId: ctx.turnId,
          toolCallId: ctx.toolCallId,
          source: 'tool',
          actor: 'main_agent',
        },
      );
      return `Created ${created.length} task(s); ledger total: ${total}.\n${renderSafeTaskLedgerText(created)}`;
    },
  };
}

function buildTaskUpdateTool(
  store: TaskLedgerStore,
  name: string,
): MakaTool<
  {
    id: string;
    status?: (typeof TASK_STATUSES)[number];
    subject?: string;
    blockedReason?: string;
    failureReason?: string;
    completionEvidence?: string;
    explicitReopen?: boolean;
  },
  string
> {
  return {
    name,
    displayName: 'Task Update',
    description:
      'Update a task in the session task ledger by id. Mark tasks in_progress when you start them; ' +
      'blocked, failed, and completed updates require a reason or evidence field. ' +
      'Reopening completed/cancelled tasks requires explicitReopen=true.',
    parameters: z
      .object({
        id: z
          .string()
          .min(1)
          .max(TASK_ID_MAX_CHARS)
          .refine(
            isSafeTaskId,
            'Task reference must be a UUID or short key from the current ledger.',
          )
          .describe('Task UUID or short key.'),
        status: z.enum(TASK_STATUSES).optional().describe('New task status.'),
        subject: z
          .string()
          .trim()
          .min(1)
          .max(TASK_SUBJECT_MAX_CHARS)
          .optional()
          .describe(`Revised task description (max ${TASK_SUBJECT_MAX_CHARS} characters).`),
        blockedReason: z
          .string()
          .trim()
          .min(1)
          .max(TASK_EVIDENCE_MAX_CHARS)
          .optional()
          .describe(
            'Required when setting status to blocked. Explain the external input, dependency, or permission needed.',
          ),
        failureReason: z
          .string()
          .trim()
          .min(1)
          .max(TASK_EVIDENCE_MAX_CHARS)
          .optional()
          .describe(
            'Required when setting status to failed. Explain why the task cannot be completed.',
          ),
        completionEvidence: z
          .string()
          .trim()
          .min(1)
          .max(TASK_EVIDENCE_MAX_CHARS)
          .optional()
          .describe(
            'Required when setting status to completed. Cite the check, tool result, artifact, or user confirmation.',
          ),
        explicitReopen: z
          .boolean()
          .optional()
          .describe(
            'Required only when reopening completed -> in_progress or cancelled -> pending.',
          ),
      })
      .superRefine((input, ctx) => {
        if (
          input.status === undefined &&
          input.subject === undefined &&
          input.blockedReason === undefined &&
          input.failureReason === undefined &&
          input.completionEvidence === undefined &&
          input.explicitReopen === undefined
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Provide at least one task field to update.',
          });
        }
        if (input.status === 'blocked' && input.blockedReason === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'blockedReason is required when status is blocked.',
            path: ['blockedReason'],
          });
        }
        if (input.status === 'failed' && input.failureReason === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'failureReason is required when status is failed.',
            path: ['failureReason'],
          });
        }
        if (input.status === 'completed' && input.completionEvidence === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'completionEvidence is required when status is completed.',
            path: ['completionEvidence'],
          });
        }
      }),
    impl: async (input, ctx) => {
      const { updated, total } = await store.update(
        ctx.sessionId,
        input.id,
        {
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.subject !== undefined ? { subject: input.subject } : {}),
          ...(input.blockedReason !== undefined ? { blockedReason: input.blockedReason } : {}),
          ...(input.failureReason !== undefined ? { failureReason: input.failureReason } : {}),
          ...(input.completionEvidence !== undefined
            ? { completionEvidence: input.completionEvidence }
            : {}),
          ...(input.explicitReopen !== undefined ? { explicitReopen: input.explicitReopen } : {}),
        },
        {
          runId: ctx.runId,
          turnId: ctx.turnId,
          toolCallId: ctx.toolCallId,
          source: 'tool',
          actor: 'main_agent',
        },
      );
      return `Updated 1 task; ledger total: ${total}.\n${renderSafeTaskLedgerText([updated])}`;
    },
  };
}

function buildTaskListTool(store: TaskLedgerStore): MakaTool<
  {
    status?: (typeof TASK_STATUSES)[number];
    include_terminal?: boolean;
    include_archived?: boolean;
  },
  string
> {
  return {
    name: TASK_LIST_TOOL_NAME,
    displayName: 'Task List',
    description: 'List the current session task ledger in compact form.',
    parameters: z
      .object({
        status: z.enum(TASK_STATUSES).optional().describe('Optional exact status filter.'),
        include_terminal: z
          .boolean()
          .optional()
          .describe('Include terminal tasks. Defaults to true for compatibility.'),
        include_archived: z
          .boolean()
          .optional()
          .describe(
            'Include terminal tasks older than seven days. Defaults to true for compatibility.',
          ),
      })
      .superRefine((input, ctx) => {
        if (
          input.status &&
          isTerminalTaskStatus(input.status) &&
          input.include_terminal === false
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['include_terminal'],
            message: 'A terminal status filter conflicts with include_terminal=false.',
          });
        }
      }),
    impl: async (input, ctx) => {
      const tasks = filterModelVisibleTaskLedgerTasks(
        await store.list(ctx.sessionId, {
          ...(input.status ? { status: input.status } : {}),
          ...(input.include_terminal !== undefined
            ? { includeTerminal: input.include_terminal }
            : {}),
          ...(input.include_archived !== undefined
            ? { includeArchived: input.include_archived }
            : {}),
        }),
      );
      return tasks.length === 0
        ? 'Task ledger is empty.'
        : `Task ledger total: ${tasks.length}.\n${renderSafeTaskLedgerText(tasks)}`;
    },
  };
}

function buildTaskGetTool(store: TaskLedgerStore): MakaTool<{ id: string }, string> {
  return {
    name: TASK_GET_TOOL_NAME,
    displayName: 'Task Get',
    description: 'Get one task from the current session task ledger by id.',
    parameters: z.object({
      id: z
        .string()
        .min(1)
        .max(TASK_ID_MAX_CHARS)
        .refine(
          isSafeTaskId,
          'Task reference must be a UUID or short key from the current ledger.',
        ),
    }),
    impl: async (input, ctx) => {
      const task = await store.get(ctx.sessionId, input.id);
      if (task?.resumeTrust === 'untrusted') return `No such task: ${input.id}`;
      if (!task) return `No such task: ${input.id}`;
      return renderSafeTaskLedgerText([task]);
    },
  };
}
