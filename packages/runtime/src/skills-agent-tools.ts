import { z } from 'zod';
import {
  loadSkillInstructions,
  rankSkillSearchCandidates,
  skillSearchResult,
  SKILL_SEARCH_RESULT_LIMIT,
  type HostCapabilities,
  type HostCapabilitiesResolver,
  type LoadSkillInstructionsResult,
  type SkillSearchResult,
} from './skills-context.js';
import {
  scanSkillsWithDiagnostics,
  type SkillSource,
  type SkillSourceResolver,
} from './skills-discovery.js';
import {
  failedSkillInvocationReceipt,
  loadedSkillInvocationReceipt,
  skillInvocationReceiptTraceData,
} from './skill-invocation-receipt.js';
import type { MakaTool, MakaToolContext } from './tool-runtime.js';

/**
 * Agent-tool builders for the Skill and SkillSearch tools.
 *
 * Depends on {@link skills-context} for instruction loading and search
 * ranking, and {@link skills-discovery} for scanning.
 */

// ── Constants ─────────────────────────────────────────────────────────────

const SKILL_SHADOW_RANK_LIMIT = 20;
const SKILL_SEARCH_INPUT_MAX_CHARS = 4_096;

/** Name of the always-on Skill tool, for hosts that bind it before the instance exists. */
export const SKILL_TOOL_NAME = 'Skill';
export const SKILL_SEARCH_TOOL_NAME = 'SkillSearch';

// ── Types ─────────────────────────────────────────────────────────────────

export interface SkillToolOptions {
  shadowTracker?: SkillShadowSelectionTracker;
}

// ── Shadow selection tracker ──────────────────────────────────────────────

export class SkillShadowSelectionTracker {
  private readonly candidatesByTurn = new Map<string, string[]>();

  record(context: Pick<MakaToolContext, 'sessionId' | 'turnId'>, refs: readonly string[]): void {
    this.candidatesByTurn.set(
      `${context.sessionId}:${context.turnId}`,
      refs.slice(0, SKILL_SHADOW_RANK_LIMIT),
    );
    if (this.candidatesByTurn.size > 100) {
      const first = this.candidatesByTurn.keys().next().value;
      if (typeof first === 'string') this.candidatesByTurn.delete(first);
    }
  }

  observe(
    context: Pick<MakaToolContext, 'sessionId' | 'turnId'>,
    ref: string,
  ): {
    rank?: number;
    candidateCount: number;
    hitAt1: boolean;
    hitAt5: boolean;
    hitAt20: boolean;
  } {
    const key = `${context.sessionId}:${context.turnId}`;
    const candidates = this.candidatesByTurn.get(key) ?? [];
    const index = candidates.indexOf(ref);
    const rank = index >= 0 ? index + 1 : undefined;
    return {
      ...(rank !== undefined ? { rank } : {}),
      candidateCount: candidates.length,
      hitAt1: rank === 1,
      hitAt5: rank !== undefined && rank <= 5,
      hitAt20: rank !== undefined && rank <= 20,
    };
  }
}

// ── Public API ────────────────────────────────────────────────────────────

export function buildSkillAgentTool(
  source: SkillSource | SkillSourceResolver,
  host?: HostCapabilities | HostCapabilitiesResolver,
  options: SkillToolOptions = {},
): MakaTool<{ name: string }, LoadSkillInstructionsResult> {
  return {
    name: SKILL_TOOL_NAME,
    description:
      'Load full instructions for one available local skill by exact ref, id, or name. Use only after the user request matches an available skill.',
    parameters: z.object({
      name: z.string().describe('The exact skill ref, id, or name from the local skill catalog.'),
    }),
    displayName: SKILL_TOOL_NAME,
    impl: async ({ name }, ctx) => {
      const result = await loadSkillInstructions(
        typeof source === 'function' ? source(ctx) : source,
        name,
        typeof host === 'function' ? host(ctx) : host,
      );
      if (result.ok) {
        const shadow = options.shadowTracker?.observe(ctx, result.skill.ref);
        const receipt = loadedSkillInvocationReceipt('model_tool', name, result.skill);
        ctx.emitRunTrace?.('skill_loaded', 'Skill instructions loaded', {
          ...skillInvocationReceiptTraceData(receipt),
          declaredTools: result.skill.declaredTools,
          ...(shadow?.rank !== undefined ? { shadowRank: shadow.rank } : {}),
          ...(shadow
            ? {
                shadowCandidateCount: shadow.candidateCount,
                shadowHitAt1: shadow.hitAt1,
                shadowHitAt5: shadow.hitAt5,
                shadowHitAt20: shadow.hitAt20,
              }
            : {}),
        });
      } else {
        const receipt = failedSkillInvocationReceipt('model_tool', name, result.reason);
        ctx.emitRunTrace?.('skill_load_failed', 'Skill instructions were not loaded', {
          ...skillInvocationReceiptTraceData(receipt),
        });
      }
      return result;
    },
  };
}

export function buildSkillSearchAgentTool(
  source: SkillSource | SkillSourceResolver,
  host?: HostCapabilities | HostCapabilitiesResolver,
  options: SkillToolOptions = {},
): MakaTool<{ query: string; limit?: number }, SkillSearchResult> {
  return {
    name: SKILL_SEARCH_TOOL_NAME,
    description:
      'Search enabled local skills by task, name, or description. Returns at most 8 metadata-only matches; call Skill with an exact ref to load instructions.',
    parameters: z.object({
      query: z.string().min(1).max(SKILL_SEARCH_INPUT_MAX_CHARS),
      limit: z.number().int().min(1).max(SKILL_SEARCH_RESULT_LIMIT).optional(),
    }),
    displayName: SKILL_SEARCH_TOOL_NAME,
    impl: async ({ query, limit }, ctx) => {
      const startedAt = performance.now();
      const resolvedSource = typeof source === 'function' ? source(ctx) : source;
      const resolvedHost = typeof host === 'function' ? host(ctx) : host;
      const scan = await scanSkillsWithDiagnostics(resolvedSource);
      const ranking = rankSkillSearchCandidates(scan.inventory, query, resolvedHost);
      const result = skillSearchResult(ranking, limit ?? SKILL_SEARCH_RESULT_LIMIT);
      options.shadowTracker?.record(
        ctx,
        ranking.ranked.slice(0, SKILL_SHADOW_RANK_LIMIT).map(({ skill }) => skill.ref),
      );
      ctx.emitRunTrace?.('skill_searched', 'Skill catalog searched', {
        queryChars: result.query.length,
        queryTruncated: result.queryTruncated,
        resultCount: result.matches.length,
        matchedCount: result.matchedCount,
        totalEligible: result.totalEligible,
        candidateReductionRatio:
          result.totalEligible > 0
            ? (result.totalEligible - result.matches.length) / result.totalEligible
            : 0,
        shadowCandidateCount: Math.min(ranking.ranked.length, SKILL_SHADOW_RANK_LIMIT),
        selectionDurationMs: Math.round((performance.now() - startedAt) * 1_000) / 1_000,
        truncated: result.truncated,
      });
      return result;
    },
  };
}
