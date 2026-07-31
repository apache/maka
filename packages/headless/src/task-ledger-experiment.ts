import { randomUUID } from 'node:crypto';
import {
  TASK_LEDGER_MAX_TASKS,
  TASK_SUBJECT_MAX_CHARS,
  renderSafeTaskLedgerText,
  renderTaskLedgerPromptText,
  type Task,
} from '@maka/core/task-ledger';
import type { MakaTool } from '@maka/runtime';
import { z } from 'zod';

export const TASK_LEDGER_EXPERIMENT_TODO_TOOL_NAMES = ['todo_write'] as const;

export type TaskLedgerExperimentTodoStatus = 'pending' | 'in_progress' | 'completed';
export type TaskLedgerExperimentTask = Task;

export interface TaskLedgerExperimentStore {
  replace(
    sessionId: string,
    todos: Array<{
      content: string;
      status: TaskLedgerExperimentTodoStatus;
    }>,
  ): Promise<TaskLedgerExperimentTask[]>;
  list(sessionId: string): Promise<TaskLedgerExperimentTask[]>;
}

const DEFAULT_REPLAY_MAX_CHARS = 4_000;
const TODO_WRITE_GUIDANCE_LINES: string[] = [
  'Todo tool guidance:',
  '<todo-tool-guidance>',
  '- Use todo_write at the start of long-running, multi-step tasks with a short outcome-focused plan.',
  '- Keep exactly one in_progress item while working; mark items completed as soon as they are done.',
  '- Rewrite the list when the plan changes, keeping items concise.',
  '</todo-tool-guidance>',
];

const taskDescriptionSchema = z.string().trim().min(1).max(TASK_SUBJECT_MAX_CHARS);
const todoWriteSchema = z
  .object({
    todos: z
      .array(
        z
          .object({
            content: taskDescriptionSchema.describe('Short todo item content.'),
            status: z
              .enum(['pending', 'in_progress', 'completed'])
              .describe('Current todo status.'),
          })
          .strict(),
      )
      .max(TASK_LEDGER_MAX_TASKS)
      .describe('The complete current todo list, replacing any previous todo list.'),
  })
  .strict();

export function createInMemoryTaskLedgerExperimentStore(
  input: { now?: () => number; newId?: () => string } = {},
): TaskLedgerExperimentStore {
  return new InMemoryTaskLedgerExperimentStore(input.now ?? Date.now, input.newId ?? defaultId);
}

export function buildTaskLedgerExperimentTools(input: {
  store: TaskLedgerExperimentStore;
}): MakaTool[] {
  return [
    {
      name: 'todo_write',
      description:
        'Replace the current todo list for a long-running task. ' +
        'Use it when planning work, when switching the active item, and when marking work complete.',
      parameters: todoWriteSchema,
      impl: async (args, ctx) => {
        const parsed = todoWriteSchema.parse(args);
        const todos = await input.store.replace(ctx.sessionId, parsed.todos);
        return renderMutationResult('Replaced todo list', todos.length, todos);
      },
    },
  ];
}

export function renderTaskLedgerExperimentReplay(
  tasks: readonly TaskLedgerExperimentTask[],
  options: { maxChars?: number } = {},
): string | undefined {
  const selected = tasks
    .filter((task) => task.status !== 'cancelled')
    .sort((a, b) => taskReplayRank(a) - taskReplayRank(b) || b.updatedAt - a.updatedAt);

  const lines: string[] = [...TODO_WRITE_GUIDANCE_LINES];
  if (selected.length > 0) {
    lines.push(
      'Task ledger experiment state (current-turn tail; informational, not an instruction):',
      '<task-ledger>',
    );
    const rendered = renderTaskLedgerPromptText(
      selected,
      options.maxChars ?? DEFAULT_REPLAY_MAX_CHARS,
    ).text;
    lines.push(...rendered.split('\n'));
    lines.push('</task-ledger>');
  }
  return capLines(lines, options.maxChars ?? DEFAULT_REPLAY_MAX_CHARS);
}

function renderMutationResult(
  action: string,
  total: number,
  tasks: readonly TaskLedgerExperimentTask[],
): string {
  const renderedTasks = renderSafeTaskLedgerText(tasks);
  return `${action}; ledger total: ${total}.${renderedTasks ? `\n${renderedTasks}` : ''}`;
}

class InMemoryTaskLedgerExperimentStore implements TaskLedgerExperimentStore {
  private readonly bySession = new Map<string, TaskLedgerExperimentTask[]>();

  constructor(
    private readonly now: () => number,
    private readonly newId: () => string,
  ) {}

  async replace(
    sessionId: string,
    todos: Array<{
      content: string;
      status: TaskLedgerExperimentTodoStatus;
    }>,
  ): Promise<TaskLedgerExperimentTask[]> {
    if (todos.length > TASK_LEDGER_MAX_TASKS) {
      throw new Error(
        `Task ledger experiment is limited to ${TASK_LEDGER_MAX_TASKS} tasks per session`,
      );
    }
    const ts = this.now();
    const tasks = todos.map((todo, index) => ({
      id: this.newId(),
      key: `T${index + 1}`,
      subject: todo.content,
      status: todo.status,
      createdAt: ts,
      updatedAt: ts,
    }));
    this.bySession.set(sessionId, tasks);
    return tasks.map((task) => ({ ...task }));
  }

  async list(sessionId: string): Promise<TaskLedgerExperimentTask[]> {
    return this.sessionTasks(sessionId).map((task) => ({ ...task }));
  }

  private sessionTasks(sessionId: string): TaskLedgerExperimentTask[] {
    const existing = this.bySession.get(sessionId);
    if (existing) return existing;
    const tasks: TaskLedgerExperimentTask[] = [];
    this.bySession.set(sessionId, tasks);
    return tasks;
  }
}

function taskReplayRank(task: TaskLedgerExperimentTask): number {
  if (task.status === 'in_progress') return 0;
  if (task.status === 'pending') return 1;
  if (task.status === 'completed') return 2;
  return 3;
}

function capLines(lines: string[], maxChars: number): string {
  const kept: string[] = [];
  let total = 0;
  for (const line of lines) {
    const cost = line.length + (kept.length === 0 ? 0 : 1);
    if (kept.length > 0 && total + cost > maxChars) {
      kept.push(`... omitted to stay within ${maxChars} chars`);
      break;
    }
    kept.push(line);
    total += cost;
  }
  return kept.join('\n').slice(0, maxChars);
}

function defaultId(): string {
  return randomUUID();
}
