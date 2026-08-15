import { rawFinishReasonString, type ModelMessage } from './model-protocol.js';
import { buildRuntimeEventModelReplayPlan } from './model-history.js';
import { toolResultOutput } from './tool-result-output.js';
import type { HistoryCompactSummaryInput } from './ai-sdk-compaction-contract.js';
import { HistoryCompactSummarizerError } from './history-compact-error.js';
import type { AiSdkUsageLike } from './model-adapter.js';
import { withProviderGenerateTracking } from './provider-request-telemetry.js';

export { HistoryCompactSummarizerError } from './history-compact-error.js';

export interface AiSdkGenerateTextOptions {
  model: unknown;
  instructions: string;
  messages: ModelMessage[];
  providerOptions?: Record<string, unknown>;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
}

export type AiSdkGenerateTextLike = (
  options: AiSdkGenerateTextOptions,
) => Promise<{ text: string; finishReason?: unknown; usage?: AiSdkUsageLike }>;

export interface BuildLlmHistorySummarizerOptions {
  /** Resolve the AI SDK model used for summarization. Reuses the session model. */
  resolveModel: () => unknown;
  /** Session provider settings, including the selected reasoning level. */
  providerOptions?: Record<string, unknown>;
  /** Injectable `generateText` for tests; defaults to the real AI SDK export. */
  generateText?: AiSdkGenerateTextLike;
}

// Conversation-summarization prompt (sectioned, modelled on pi/opencode):
// asks for a checkpoint another LLM can continue from. Tool calls and their
// results are part of the conversation sent to the summarizer, because the
// folded events are projected with the same policy the model would see them.
const SUMMARIZATION_SYSTEM_PROMPT = [
  'You are a context summarization assistant.',
  'Read the conversation between a user and an AI assistant, then produce a structured summary another LLM will use to continue the same task.',
  'Do NOT continue the conversation. Do NOT answer questions in it. ONLY output the structured summary.',
  '',
  'Use this exact format:',
  '',
  '## Goal',
  '[What the user is trying to accomplish]',
  '',
  '## Progress',
  '### Done',
  '- [Completed work and changes]',
  '### In Progress',
  '- [Current work]',
  '',
  '## Key Decisions',
  '- **[Decision]**: [Brief rationale]',
  '',
  '## Next Steps',
  '1. [Ordered list of what should happen next]',
  '',
  '## Critical Context',
  '- [Files, commands/results, errors, anything needed to continue; or "(none)"]',
  '',
  'Keep each section concise. Preserve exact file paths, function names, commands, and error messages.',
].join('\n');

export function buildLlmHistorySummarizer(options: BuildLlmHistorySummarizerOptions) {
  return async (input: HistoryCompactSummaryInput): Promise<string | undefined> => {
    const newlyFoldedRuntimeEvents =
      input.newlyFoldedRuntimeEvents ?? input.source.foldedRuntimeEvents;
    if (newlyFoldedRuntimeEvents.length === 0) return input.previousCheckpoint?.summary;
    try {
      const plan = buildRuntimeEventModelReplayPlan(newlyFoldedRuntimeEvents);
      const messages = replayPlanItemsToModelMessages(plan.items);
      if (input.previousCheckpoint) {
        messages.unshift({
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Previous continuation summary:\n${input.previousCheckpoint.summary}\n\nUpdate it using the newer conversation events that follow.`,
            },
          ],
        });
      }
      // Handed over whole by the backend, which owns every input a tracker
      // needs — including the run, which no summarizer wiring can know (#1679).
      const providerRequestTracker = input.providerRequestTracker;
      const ai =
        options.generateText && !providerRequestTracker ? undefined : await loadAiSdkTextModule();
      const generateText = options.generateText ?? ai!.generateText;
      const model = providerRequestTracker
        ? withProviderGenerateTracking({
            model: options.resolveModel(),
            wrapLanguageModel: ai!.wrapLanguageModel,
            tracker: providerRequestTracker,
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          })
        : options.resolveModel();
      const result = await generateText({
        model,
        instructions: SUMMARIZATION_SYSTEM_PROMPT,
        messages,
        ...(options.providerOptions !== undefined
          ? { providerOptions: options.providerOptions }
          : {}),
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      });
      if (rawFinishReasonString(result.finishReason) === 'length') {
        throw new HistoryCompactSummarizerError('output_length');
      }
      return result.text;
    } catch (error) {
      if (error instanceof HistoryCompactSummarizerError) throw error;
      throw new HistoryCompactSummarizerError('provider_error', { cause: error });
    }
  };
}

interface AiSdkTextModule {
  generateText: AiSdkGenerateTextLike;
  wrapLanguageModel(input: Record<string, unknown>): unknown;
}

async function loadAiSdkTextModule(): Promise<AiSdkTextModule> {
  const ai = await import('ai').catch((err) => {
    throw new Error(
      `Failed to load 'ai' package for history summarization. Run \`npm install ai\`. Inner: ${(err as Error).message}`,
    );
  });
  return ai as unknown as AiSdkTextModule;
}

type ReplayPlanItems = ReturnType<typeof buildRuntimeEventModelReplayPlan>['items'];

export function replayPlanItemsToModelMessages(items: ReplayPlanItems): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const item of items) {
    if (item.kind === 'text') {
      // Split on role so each push matches exactly one ModelMessage arm — no cast.
      const textPart = { type: 'text' as const, text: item.content };
      if (item.role === 'user') {
        out.push({ role: 'user', content: [textPart] });
      } else {
        out.push({ role: 'assistant', content: [textPart] });
      }
    } else if (item.kind === 'tool_call') {
      // Merge consecutive tool calls into ONE assistant message, mirroring the
      // primary materializer's step merge (model-history.ts): strict
      // OpenAI-compatible providers 400 when an assistant message's tool_calls
      // are interrupted by another assistant message before their tool
      // results arrive (#3030).
      const toolCallPart = {
        type: 'tool-call' as const,
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        input: item.input,
      };
      const previous = out[out.length - 1];
      if (
        previous?.role === 'assistant' &&
        Array.isArray(previous.content) &&
        previous.content.every((part) => part.type === 'tool-call')
      ) {
        previous.content.push(toolCallPart);
      } else {
        out.push({ role: 'assistant', content: [toolCallPart] });
      }
    } else if (item.kind === 'tool_result') {
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: item.toolCallId,
            toolName: item.toolName,
            output: toolResultOutput(item.output, item.isError),
          },
        ],
      });
    }
    // thinking entries are intentionally skipped for summarization
  }
  return out;
}
