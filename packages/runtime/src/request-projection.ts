import type { ModelMessage, NormalizedUsage, ToolCallPart } from './model-protocol.js';

export interface CompletedProviderStep {
  toolCalls?: readonly ToolCallPart[];
  usage?: NormalizedUsage;
}

export interface RequestProjectionContext {
  completedSteps: readonly CompletedProviderStep[];
  stepNumber: number;
  model: unknown;
  messages: ModelMessage[];
  activeTools?: readonly string[];
}

export interface RequestProjection {
  activeTools?: string[];
  messages?: ModelMessage[];
}

export type RequestProjectionStage = (
  context: RequestProjectionContext,
) => RequestProjection | undefined | PromiseLike<RequestProjection | undefined>;

/**
 * Deterministic request-projection pipeline over ONE provider-visible request.
 * Order is a contract: mid-turn capacity compaction runs first among the
 * message-shaping hooks so every later mechanism operates on (and re-converges
 * onto) its projection — active tool-result pruning re-archives large tool
 * results in the rebuilt tail, and semantic/active-full compaction sees the
 * already-compacted messages. On a step where the capacity hook replaced the
 * request, semantic/active-full compaction yields (see AiSdkBackend.send) so
 * two summarizers never run for one step.
 *
 * Every hook here only SHAPES the projection. The pass/terminate capacity
 * verdict is issued once, after the whole pipeline, by the final-request
 * estimate owner (buildMidTurnFinalRequestVerdict) over the actual outgoing
 * (messages, tools) payload — never by an individual hook over an intermediate
 * projection that a later hook could still rescue.
 */
export function composeRequestProjection(
  toolAvailability: RequestProjectionStage | undefined,
  midTurnCapacityCompact: RequestProjectionStage | undefined,
  activeToolResultPrune: RequestProjectionStage | undefined,
  activeFullCompact?: RequestProjectionStage | undefined,
): RequestProjectionStage | undefined {
  const hooks = [
    toolAvailability,
    midTurnCapacityCompact,
    activeToolResultPrune,
    activeFullCompact,
  ].filter(Boolean) as RequestProjectionStage[];
  if (hooks.length === 0) return undefined;
  return async (context: RequestProjectionContext): Promise<RequestProjection | undefined> => {
    let result: RequestProjection | undefined;
    let messages = context.messages;
    for (const hook of hooks) {
      const hookOptions = {
        ...context,
        messages,
        ...(result?.activeTools ? { activeTools: result.activeTools } : {}),
      } as RequestProjectionContext;
      const hookResult = await Promise.resolve(hook(hookOptions));
      if (!hookResult) continue;
      result = {
        ...(result ?? {}),
        ...hookResult,
        activeTools: hookResult.activeTools ?? result?.activeTools,
      };
      if (hookResult.messages) messages = hookResult.messages;
    }
    return result;
  };
}
