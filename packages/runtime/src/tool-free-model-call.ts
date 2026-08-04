import type { ModelMessage } from './model-protocol.js';
import { normalizeAiSdkUsage, type AiSdkUsageLike } from './model-adapter.js';
import { rawFinishReasonString, type NormalizedUsage } from './model-protocol.js';

export type ToolFreeModelCallContent =
  | { readonly prompt: string; readonly messages?: never }
  | { readonly prompt?: never; readonly messages: readonly ModelMessage[] };

export type ToolFreeModelCallInput = ToolFreeModelCallContent & {
  readonly model: unknown;
  readonly providerOptions?: unknown;
  readonly abortSignal?: AbortSignal;
  readonly maxOutputTokens: number;
};

export interface ToolFreeModelCallResult {
  readonly text: string;
  readonly usage?: NormalizedUsage;
  readonly finishReason?: string;
}

/** Runs one model call without exposing tools and returns its accounting facts. */
export async function generateToolFreeModelCall(
  input: ToolFreeModelCallInput,
): Promise<ToolFreeModelCallResult> {
  const ai = (await import('ai')) as unknown as {
    generateText(options: Record<string, unknown>): Promise<{
      text: string;
      usage?: AiSdkUsageLike;
      finishReason?: unknown;
    }>;
  };
  const result = await ai.generateText({
    model: input.model,
    ...(input.prompt === undefined ? { messages: input.messages } : { prompt: input.prompt }),
    ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    ...(input.providerOptions === undefined ? {} : { providerOptions: input.providerOptions }),
    maxOutputTokens: input.maxOutputTokens,
  });
  const usage = normalizeAiSdkUsage(result.usage, { rawFinishReason: result.finishReason });
  const finishReason = rawFinishReasonString(result.finishReason);
  return {
    text: result.text,
    ...(usage ? { usage } : {}),
    ...(finishReason ? { finishReason } : {}),
  };
}
