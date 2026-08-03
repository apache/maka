import type { MakaTool, MakaToolContext } from '@maka/runtime';
import { z } from 'zod';
import type { HeavyTaskInventoryState, HeavyTaskTodoState } from './task-contracts.js';
import type { TaskRunWriter } from './task-run-store.js';

export const HEAVY_TASK_PROGRESS_TOOL_NAMES = ['inventory_submit', 'todo_update'] as const;

const MAX_SUMMARY_CHARS = 2_000;
const MAX_ITEM_CHARS = 1_000;
const MAX_PATH_CHARS = 500;
const MAX_INVENTORY_ITEMS = 100;
const MAX_TODO_ITEMS = 100;
const MAX_OPEN_QUESTIONS = 25;

export const heavyTaskInventoryItemSchema = z
  .object({
    path: z.string().trim().min(1).max(MAX_PATH_CHARS),
    kind: z.enum(['file', 'directory', 'artifact', 'command', 'unknown']),
    status: z.enum(['observed', 'planned', 'unknown']),
    purpose: z.string().trim().min(1).max(MAX_ITEM_CHARS).optional(),
    evidence: z.string().trim().min(1).max(MAX_ITEM_CHARS).optional(),
  })
  .strict();

export const heavyTaskInventorySubmitSchema = z
  .object({
    summary: z.string().trim().min(1).max(MAX_SUMMARY_CHARS),
    items: z.array(heavyTaskInventoryItemSchema).max(MAX_INVENTORY_ITEMS),
    openQuestions: z
      .array(z.string().trim().min(1).max(MAX_ITEM_CHARS))
      .max(MAX_OPEN_QUESTIONS)
      .optional(),
  })
  .strict();

export const heavyTaskTodoItemSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9._:-]+$/),
    content: z.string().trim().min(1).max(MAX_ITEM_CHARS),
    kind: z
      .enum([
        'inspect',
        'implement',
        'runnable_artifact',
        'public_check',
        'repair',
        'final_self_check',
      ])
      .optional()
      .describe(
        'Optional lightweight phase marker. Use runnable_artifact and public_check for the early runnable/check gate.',
      ),
    status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
    priority: z.enum(['high', 'medium', 'low']),
    evidence: z.string().trim().min(1).max(MAX_ITEM_CHARS).optional(),
  })
  .strict();

export const heavyTaskTodoUpdateSchema = z
  .object({
    items: z.array(heavyTaskTodoItemSchema).max(MAX_TODO_ITEMS),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    let inProgress = 0;
    for (const item of value.items) {
      if (ids.has(item.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items'],
          message: `duplicate todo id: ${item.id}`,
        });
      }
      ids.add(item.id);
      if (item.status === 'in_progress') inProgress += 1;
    }
    if (inProgress > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'at most one todo item may be in_progress',
      });
    }
  });

export type HeavyTaskInventorySubmitInput = z.infer<typeof heavyTaskInventorySubmitSchema>;
export type HeavyTaskTodoUpdateInput = z.infer<typeof heavyTaskTodoUpdateSchema>;

export interface HeavyTaskProgressRecorder {
  recordInventory(
    input: HeavyTaskInventorySubmitInput,
    ctx: MakaToolContext,
  ): Promise<HeavyTaskInventoryState>;
  recordTodos(input: HeavyTaskTodoUpdateInput, ctx: MakaToolContext): Promise<HeavyTaskTodoState>;
}

export function createHeavyTaskProgressRecorder(input: {
  taskRunId: string;
  attemptId?: string;
  store: TaskRunWriter;
  now: () => number;
  newId: () => string;
}): HeavyTaskProgressRecorder {
  return {
    async recordInventory(args, ctx) {
      const ts = input.now();
      const inventory: HeavyTaskInventoryState = {
        schemaVersion: 1,
        inventoryId: input.newId(),
        taskRunId: input.taskRunId,
        ...(input.attemptId ? { attemptId: input.attemptId } : {}),
        ts,
        summary: args.summary,
        items: args.items,
        ...(args.openQuestions ? { openQuestions: args.openQuestions } : {}),
        source: sourceFromContext(ctx),
      };
      await input.store.appendEvent(input.taskRunId, {
        type: 'heavy_task_inventory_recorded',
        id: input.newId(),
        taskRunId: input.taskRunId,
        ts,
        inventory,
      });
      return inventory;
    },
    async recordTodos(args, ctx) {
      const ts = input.now();
      const todos: HeavyTaskTodoState = {
        schemaVersion: 1,
        todoSetId: input.newId(),
        taskRunId: input.taskRunId,
        ...(input.attemptId ? { attemptId: input.attemptId } : {}),
        ts,
        items: args.items,
        source: sourceFromContext(ctx),
      };
      await input.store.appendEvent(input.taskRunId, {
        type: 'heavy_task_todos_recorded',
        id: input.newId(),
        taskRunId: input.taskRunId,
        ts,
        todos,
      });
      return todos;
    },
  };
}

export function buildHeavyTaskProgressTools(recorder: HeavyTaskProgressRecorder): MakaTool[] {
  return [
    {
      name: 'inventory_submit',
      description: 'Submit a full structured inventory snapshot for this heavy-task run.',
      parameters: heavyTaskInventorySubmitSchema,
      impl: async (args, ctx) => {
        const inventory = await recorder.recordInventory(
          heavyTaskInventorySubmitSchema.parse(args),
          ctx,
        );
        return { accepted: true, inventory };
      },
    },
    {
      name: 'todo_update',
      description: 'Submit the full current todo/progress snapshot for this heavy-task run.',
      parameters: heavyTaskTodoUpdateSchema,
      impl: async (args, ctx) => {
        const todos = await recorder.recordTodos(heavyTaskTodoUpdateSchema.parse(args), ctx);
        return { accepted: true, todos };
      },
    },
  ];
}

export function renderHeavyTaskProgressForPrompt(projection: {
  latestHeavyTaskInventory?: HeavyTaskInventoryState;
  latestHeavyTaskTodos?: HeavyTaskTodoState;
}): string | undefined {
  const inventory = projection.latestHeavyTaskInventory;
  const todos = projection.latestHeavyTaskTodos;
  if (!inventory && !todos) return undefined;

  const lines = ['Heavy-task progress state from prior task-run events:'];
  if (inventory) {
    lines.push(`- Inventory summary: ${oneLine(inventory.summary, 240)}`);
    for (const item of inventory.items.slice(0, 12)) {
      const purpose = item.purpose ? ` - ${oneLine(item.purpose, 120)}` : '';
      lines.push(`  - ${item.kind}:${item.status} ${oneLine(item.path, 120)}${purpose}`);
    }
    if (inventory.items.length > 12) {
      lines.push(`  - ${inventory.items.length - 12} more inventory item(s) omitted`);
    }
    if (inventory.openQuestions?.length) {
      lines.push(
        `- Open questions: ${inventory.openQuestions
          .slice(0, 5)
          .map((value) => oneLine(value, 120))
          .join('; ')}`,
      );
    }
  }
  if (todos) {
    const active = todos.items.find((item) => item.status === 'in_progress');
    lines.push(`- Active todo: ${active ? active.id : 'none'}`);
    for (const item of todos.items.slice(0, 12)) {
      const kind = item.kind ? ` ${item.kind}` : '';
      lines.push(
        `  - [${item.status}] (${item.priority})${kind} ${item.id}: ${oneLine(item.content, 160)}`,
      );
    }
    if (todos.items.length > 12) {
      lines.push(`  - ${todos.items.length - 12} more todo item(s) omitted`);
    }
  }
  lines.push('Use inventory_submit and todo_update to refresh this state when it changes.');
  return lines.join('\n');
}

function sourceFromContext(ctx: MakaToolContext): HeavyTaskInventoryState['source'] {
  return {
    kind: 'model_tool',
    toolCallId: ctx.toolCallId,
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
  };
}

function oneLine(value: string, maxChars: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 3)}...`;
}
