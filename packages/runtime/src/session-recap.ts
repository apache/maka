import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeExecutionConnection } from '@maka/core/llm-connections';
import { applyRuntimeEventContextBudget } from './context-budget.js';
import {
  buildDefaultContextBudgetPolicy,
  resolveSelectedModelContextWindow,
} from './context-budget-policy.js';
import { replayPlanItemsToModelMessages } from './history-compact-summarizer.js';
import { buildRuntimeEventModelReplayPlan } from './model-history.js';
import type { ModelMessage } from './model-protocol.js';

export const SESSION_RECAP_INSTRUCTION =
  '<system-reminder>The user is returning to this session after being away. Write ONE sentence (roughly 25-40 words) recapping where things stand so they can resume instantly. Write the sentence in the language of the user\'s most recent substantive message; for mixed-language sessions use the dominant language of the user\'s messages. Lead with agency, phrased naturally in that language: if the session was mainly questions or review with no landed change, open by referencing what the user asked (the equivalent of "You asked ..."); if the agent landed changes, reference what was done (the equivalent of "We fixed/added/wired ..."); if almost nothing happened, say in that language that the session had just begun. Output only the sentence - no labels, no quotes, no preamble.</system-reminder>';

export function buildSessionRecapMessages(input: {
  readonly events: readonly RuntimeEvent[];
  readonly connection: RuntimeExecutionConnection;
  readonly modelId: string;
}): ModelMessage[] {
  const contextWindow = resolveSelectedModelContextWindow(input.connection, input.modelId);
  let events = input.events;
  if (contextWindow !== undefined) {
    const budget = buildDefaultContextBudgetPolicy(input.connection, {
      name: 'session-recap-history-budget',
      modelId: input.modelId,
    });
    if (budget?.maxHistoryEstimatedTokens !== undefined) {
      budget.maxHistoryEstimatedTokens = Math.max(0, Math.floor(contextWindow * 0.85) - 4_096);
    }
    events = applyRuntimeEventContextBudget(events, budget)?.events ?? events;
  }
  const messages = replayPlanItemsToModelMessages(buildRuntimeEventModelReplayPlan(events).items);
  messages.push({ role: 'user', content: SESSION_RECAP_INSTRUCTION });
  return messages;
}

export function cleanSessionRecapText(raw: string): string {
  let text = raw.replace(/\s+/g, ' ').trim();
  text = text.replace(/^(recap|summary|回顾)\s*[:：]\s*/i, '').trim();

  const quotePairs: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
  ];
  for (const [open, close] of quotePairs) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(open.length, text.length - close.length).trim();
      break;
    }
  }

  return text.length > 1_200 ? `${text.slice(0, 1_200)}…` : text;
}
