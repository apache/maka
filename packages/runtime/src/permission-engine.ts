/**
 * PermissionEngine — runtime wrapper around core's pure `preToolUse()`.
 *
 * Owns:
 * - requestId generation (uuid)
 * - per-turn "remember" set scoped to a specific tool intent
 * - parked Promise registry (one Promise per outstanding permission_request,
 *   keyed by requestId)
 * - response routing back to the awaiting adapter
 *
 * Adapter contract (see AiSdkBackend tool execute wrapper):
 *
 *   const decision = await engine.evaluate({ sessionId, turnId, toolUseId, toolName, args, mode });
 *   if (decision.kind === 'allow') { ...proceed with tool... }
 *   else if (decision.kind === 'block') { ...synthesize tool_result(isError) with decision.reason... }
 *   else if (decision.kind === 'prompt') {
 *     emit(decision.event);                                  // PermissionRequestEvent
 *     const userResponse = await decision.parked;            // resolves on respondToPermission()
 *     // record decision messages + ack event via callbacks
 *   }
 */

import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import {
  classifyToolUse,
  matchToolPermissionRules,
  preToolUse,
  type PermissionMode,
  type PermissionRequest,
  type PermissionResponse,
  type PreToolUseResult,
  type ToolCategory,
  type ToolExecutionFacts,
  type ToolPermissionRule,
} from '@maka/core/permission';
import type { AnyPermissionRequestEvent, PermissionDecisionAckEvent } from '@maka/core/events';
import type {
  HostedInteractionBridge,
  HostedPermissionAnswer,
  HostedPermissionSettlement,
} from '@maka/core/backend-types';
import {
  DEFAULT_ADDITIONAL_PERMISSION_GRANT_TTL_MS,
  AdditionalPermissionError,
  assertAdditionalPermissionProposal,
  freezeAdditionalPermissionGrant,
  freezeAdditionalPermissionProposal,
  type AdditionalPermissionGrant,
  type AdditionalPermissionProposal,
} from './additional-permissions.js';
import {
  DEFAULT_SANDBOX_ESCALATION_GRANT_TTL_MS,
  SandboxEscalationError,
  assertSandboxEscalationProposal,
  freezeSandboxEscalationGrant,
  freezeSandboxEscalationProposal,
  type SandboxEscalationGrant,
  type SandboxEscalationProposal,
} from './sandbox-escalation.js';
import { TurnScopedAwaitRegistry } from './turn-scoped-await-registry.js';
import {
  RuntimeInteractionAdmissionRejectedError,
  RuntimeInteractionClosedError,
  RuntimeInteractionFailStopError,
  RuntimeInteractionInvariantError,
  type RuntimeInteractionClosureReason,
} from './interaction-authority.js';

// ============================================================================
// Per-turn state
// ============================================================================

interface TurnState {
  turnId: string;
  /** Tool-intent scopes granted with `rememberForTurn: true` in this turn. */
  remembered: Set<string>;
  rememberScopeIds: Map<string, string>;
  /** Approved one-shot grants keyed by their bound tool invocation. */
  additionalGrants: Map<string, PendingAdditionalPermissionGrant>;
  /** Approved exact unsandboxed-command grants keyed by tool invocation. */
  sandboxEscalationGrants: Map<string, PendingSandboxEscalationGrant>;
}

interface ParkedPermission {
  sessionId: string;
  turnId: string;
  toolUseId: string;
  toolName: string;
  category: ToolCategory;
  scopeKey: string;
  rememberForTurnAllowed: boolean;
  hosted?: {
    bridge: HostedInteractionBridge;
    commitStarted: boolean;
  };
  additionalProposal?: AdditionalPermissionProposal;
  sandboxEscalationProposal?: SandboxEscalationProposal;
}

interface PendingAdditionalPermissionGrant {
  grant: AdditionalPermissionGrant;
  consumed: boolean;
}

interface PendingSandboxEscalationGrant {
  grant: SandboxEscalationGrant;
  consumed: boolean;
}

// ============================================================================
// Evaluate result shapes
// ============================================================================

export type EvaluateResult =
  | { kind: 'allow'; category: ToolCategory }
  | {
      kind: 'block';
      category: ToolCategory;
      reason: string;
      /** Present for an invocation-local explicit deny so observers record a failed invocation. */
      decisionEvent?: PermissionDecisionAckEvent;
    }
  | {
      kind: 'prompt';
      category: ToolCategory;
      event: AnyPermissionRequestEvent;
      /** Stable non-secret identity used for remember-for-turn siblings. */
      rememberScopeId?: string;
      /** Exact local settlement owned by PermissionEngine for hosted admission. */
      settlement?: HostedPermissionSettlement;
      /** Resolves when the user responds via respondToPermission(). */
      parked: Promise<PermissionResponse>;
    };

export interface EvaluateInput {
  /** The session this evaluation runs in. */
  sessionId: string;
  /** Current agent turn id (groups permission state). */
  turnId: string;
  /** Exact active Run identity when a backend can provide it. */
  runId?: string;
  /** Exact hosted Interaction bridge. Omitted for embedded execution. */
  hostedInteraction?: HostedInteractionBridge;
  /** The SDK's id for the tool invocation. */
  toolUseId: string;
  toolName: string;
  args: unknown;
  categoryHint?: ToolCategory;
  /** Session's current permission mode. */
  mode: PermissionMode;
  /** Optional hint shown to user in the dialog. */
  hint?: string;
  /** Runtime-normalized one-shot permission proposal for this exact tool intent. */
  additionalPermissionProposal?: AdditionalPermissionProposal;
  /** Runtime-normalized request to execute this exact Bash command without a platform sandbox. */
  sandboxEscalationProposal?: SandboxEscalationProposal;
  /** Canonical cwd displayed with an additional permission request. */
  cwd?: string;
  /** Optional trusted facts about the executor that would run this tool. */
  executionFacts?: ToolExecutionFacts;
  /** Whether the tool participates in the base mode policy when no explicit rule matches. */
  permissionRequired?: boolean;
  /** Invocation-local rules. Explicit deny wins over allow, then base mode applies. */
  permissionRules?: readonly ToolPermissionRule[];
  /** Optional trusted platform sandbox availability for sandbox-aware policy. */
  sandbox?: {
    platformSandboxAvailable: boolean;
  };
}

// ============================================================================
// Engine
// ============================================================================

export interface PermissionEngineDeps {
  /** Generate a fresh uuid. Injectable for tests. */
  newId: () => string;
  /** Wall-clock for event timestamps. Injectable for tests. */
  now: () => number;
}

export class PermissionEngine {
  private readonly turns = new Map<string, TurnState>();
  private readonly parked = new TurnScopedAwaitRegistry<PermissionResponse, ParkedPermission>();
  private readonly deferredTurnClosures = new Set<string>();

  constructor(private readonly deps: PermissionEngineDeps) {}

  /** Begin tracking a new turn. Idempotent. */
  beginTurn(turnId: string): void {
    if (!this.turns.has(turnId)) {
      this.turns.set(turnId, {
        turnId,
        remembered: new Set(),
        rememberScopeIds: new Map(),
        additionalGrants: new Map(),
        sandboxEscalationGrants: new Map(),
      });
    }
    this.parked.beginTurn(turnId);
  }

  /** End tracking, rejecting any still-parked requests as user_stop. */
  endTurn(turnId: string, reason: 'completed' | 'aborted' = 'completed'): void {
    const state = this.turns.get(turnId);
    if (!state) return;
    if (this.parked.entries(turnId).some(([, parked]) => parked.hosted)) {
      this.deferredTurnClosures.add(turnId);
      this.finishDeferredTurnClosure(turnId);
      return;
    }
    this.parked.endTurn(turnId, (requestId, parked) => {
      const message = `Turn ${turnId} ${reason} before permission request ${requestId} was answered`;
      return parked.additionalProposal
        ? new AdditionalPermissionError({
            stage: 'approval',
            reason: 'additional_permission_aborted',
            message,
            recoverable: true,
          })
        : parked.sandboxEscalationProposal
          ? new SandboxEscalationError({
              stage: 'approval',
              reason: 'sandbox_escalation_aborted',
              message,
              recoverable: true,
            })
          : new Error(message);
    });
    this.turns.delete(turnId);
  }

  /**
   * Evaluate a tool intent against the policy matrix and session state.
   * Returns one of three kinds; for 'prompt' the caller emits the event
   * and awaits `parked`.
   */
  evaluate(input: EvaluateInput): EvaluateResult {
    const state = this.requireTurn(input.turnId);
    const hostedInteraction = input.hostedInteraction;
    if (
      hostedInteraction &&
      (hostedInteraction.sessionId !== input.sessionId ||
        hostedInteraction.turnId !== input.turnId ||
        (input.runId !== undefined && hostedInteraction.runId !== input.runId))
    ) {
      throw new RuntimeInteractionInvariantError(
        `Permission evaluation has a mismatched hosted Run for turn ${input.turnId}`,
      );
    }
    const args = snapshotPermissionArgs(input.args);

    const category = classifyToolUse({
      toolName: input.toolName,
      args,
      ...(input.categoryHint !== undefined ? { categoryHint: input.categoryHint } : {}),
    });
    const ruleDecision = matchToolPermissionRules({
      toolName: input.toolName,
      args,
      category,
      rules: input.permissionRules ?? [],
    });
    const hasAdditionalProposal = input.additionalPermissionProposal !== undefined;
    const hasSandboxEscalationProposal = input.sandboxEscalationProposal !== undefined;
    const hasOneShotProposal = hasAdditionalProposal || hasSandboxEscalationProposal;
    if (ruleDecision === 'allow' && !hasOneShotProposal) return { kind: 'allow', category };
    if (ruleDecision === 'deny') {
      const requestId = this.deps.newId();
      return {
        kind: 'block',
        category,
        reason: `Tool ${input.toolName} was denied by an invocation permission rule`,
        decisionEvent: {
          type: 'permission_decision_ack',
          id: this.deps.newId(),
          turnId: input.turnId,
          ts: this.deps.now(),
          requestId,
          toolUseId: input.toolUseId,
          decision: 'deny',
        },
      };
    }
    if (ruleDecision === undefined && input.permissionRequired === false && !hasOneShotProposal) {
      return { kind: 'allow', category };
    }

    const pre: PreToolUseResult = preToolUse({
      toolName: input.toolName,
      args,
      ...(input.categoryHint !== undefined ? { categoryHint: input.categoryHint } : {}),
      ...(input.executionFacts !== undefined ? { executionFacts: input.executionFacts } : {}),
      ...(input.sandbox !== undefined ? { sandbox: input.sandbox } : {}),
      mode: input.mode,
      // Hosted siblings always establish their own request and durable outcome.
      // The Host may settle a late sibling during admission from its remembered winner.
      turnRemembered: hostedInteraction ? new Set() : state.remembered,
    });

    let additional = input.additionalPermissionProposal;
    let sandboxEscalation = input.sandboxEscalationProposal;
    if (additional && sandboxEscalation) {
      return {
        kind: 'block',
        category: pre.category,
        reason: 'Additional permissions and sandbox escalation cannot be requested together.',
      };
    }
    if (additional) {
      try {
        assertAdditionalPermissionProposal({
          proposal: additional,
          toolName: input.toolName,
          args,
        });
        additional = freezeAdditionalPermissionProposal(additional);
      } catch (error) {
        return {
          kind: 'block',
          category: pre.category,
          reason:
            error instanceof AdditionalPermissionError
              ? error.message
              : 'Additional permission proposal validation failed.',
        };
      }
      if (input.mode === 'explore') {
        return {
          kind: 'block',
          category: pre.category,
          reason: 'Additional permissions are blocked in explore mode.',
        };
      }
      if (input.mode === 'bypass') return { kind: 'allow', category: pre.category };
      if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd)) {
        return {
          kind: 'block',
          category: pre.category,
          reason: 'Additional permission requests require a canonical cwd.',
        };
      }
    }

    if (sandboxEscalation) {
      try {
        assertSandboxEscalationProposal({
          proposal: sandboxEscalation,
          toolName: input.toolName,
          args,
          cwd: input.cwd ?? '',
        });
        sandboxEscalation = freezeSandboxEscalationProposal(sandboxEscalation);
      } catch (error) {
        return {
          kind: 'block',
          category: pre.category,
          reason:
            error instanceof SandboxEscalationError
              ? error.message
              : 'Sandbox escalation proposal validation failed.',
        };
      }
      if (input.mode === 'explore') {
        return {
          kind: 'block',
          category: pre.category,
          reason: 'Sandbox escalation is blocked in explore mode.',
        };
      }
      if (input.mode === 'bypass') return { kind: 'allow', category: pre.category };
      if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd)) {
        return {
          kind: 'block',
          category: pre.category,
          reason: 'Sandbox escalation requests require a canonical cwd.',
        };
      }
    }

    const baseExplicitlyAllowed =
      ruleDecision === 'allow' ||
      (ruleDecision === undefined && input.permissionRequired === false);
    const baseAllowed = baseExplicitlyAllowed || pre.proceed;

    if (!baseExplicitlyAllowed && pre.blockReason !== undefined) {
      return { kind: 'block', category: pre.category, reason: pre.blockReason };
    }
    if (baseAllowed && !additional && !sandboxEscalation) {
      return { kind: 'allow', category: pre.category };
    }
    if (!additional && !sandboxEscalation && !pre.partialRequest) {
      // Defensive: pre.proceed=false && !blockReason && !partialRequest is
      // unreachable per the type contract, but TS doesn't know that. Treat
      // as block to fail safe.
      return {
        kind: 'block',
        category: pre.category,
        reason: 'PermissionEngine: invariant violated — no partialRequest in prompt branch',
      };
    }

    const requestId = this.deps.newId();
    const event: AnyPermissionRequestEvent = additional
      ? {
          type: 'permission_request',
          kind: 'additional_permissions',
          id: this.deps.newId(),
          turnId: input.turnId,
          ts: this.deps.now(),
          requestId,
          toolUseId: input.toolUseId,
          toolName: input.toolName,
          category: pre.category,
          reason: 'additional_permissions',
          args: undefined,
          additionalPermissions: additional.profile,
          cwd: input.cwd!,
          justification: additional.justification,
          intentHash: additional.intentHash,
          permissionsHash: additional.permissionsHash,
          risk: additional.risk,
          alsoApprovesToolExecution: !baseAllowed,
          availableDecisions: ['allow_once', 'deny'],
          rememberForTurnAllowed: false,
          ...(input.hint !== undefined ? { hint: input.hint } : {}),
        }
      : sandboxEscalation
        ? {
            type: 'permission_request',
            kind: 'sandbox_escalation',
            id: this.deps.newId(),
            turnId: input.turnId,
            ts: this.deps.now(),
            requestId,
            toolUseId: input.toolUseId,
            toolName: 'Bash',
            category: pre.category,
            reason: 'sandbox_escalation',
            args: undefined,
            command: sandboxEscalation.command,
            cwd: sandboxEscalation.cwd,
            justification: sandboxEscalation.justification,
            intentHash: sandboxEscalation.intentHash,
            commandHash: sandboxEscalation.commandHash,
            trigger: sandboxEscalation.trigger,
            risk: sandboxEscalation.risk,
            alsoApprovesToolExecution: !baseAllowed,
            availableDecisions: ['allow_once', 'deny'],
            rememberForTurnAllowed: false,
            ...(input.hint !== undefined ? { hint: input.hint } : {}),
          }
        : {
            type: 'permission_request',
            kind: 'tool_permission',
            id: this.deps.newId(),
            turnId: input.turnId,
            ts: this.deps.now(),
            requestId,
            toolUseId: input.toolUseId,
            toolName: pre.partialRequest!.toolName,
            category: pre.partialRequest!.category,
            reason: pre.partialRequest!.reason,
            args: pre.partialRequest!.args,
            rememberForTurnAllowed: pre.partialRequest!.rememberForTurnAllowed,
            ...(input.hint !== undefined ? { hint: input.hint } : {}),
          };

    const parked = this.parked.park(input.turnId, requestId, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolUseId: input.toolUseId,
      toolName: input.toolName,
      category: pre.category,
      scopeKey: pre.scopeKey,
      rememberForTurnAllowed: additional
        ? false
        : sandboxEscalation
          ? false
          : pre.partialRequest!.rememberForTurnAllowed,
      ...(hostedInteraction ? { hosted: { bridge: hostedInteraction, commitStarted: false } } : {}),
      ...(additional ? { additionalProposal: additional } : {}),
      ...(sandboxEscalation ? { sandboxEscalationProposal: sandboxEscalation } : {}),
    });

    return {
      kind: 'prompt',
      category: pre.category,
      event,
      ...(event.kind === 'tool_permission' && event.rememberForTurnAllowed
        ? {
            rememberScopeId: this.rememberScopeId(state, pre.scopeKey, requestId),
          }
        : {}),
      ...(hostedInteraction
        ? { settlement: this.createHostedSettlement(input.turnId, requestId) }
        : {}),
      parked,
    };
  }

  private createHostedSettlement(turnId: string, requestId: string): HostedPermissionSettlement {
    return Object.freeze({
      applyAnswer: async (answer: HostedPermissionAnswer): Promise<void> => {
        if (Object.hasOwn(answer, 'requestId')) {
          throw new RuntimeInteractionInvariantError(
            `Permission settlement ${requestId} received a routed answer`,
          );
        }
        this.settleCommittedResponse(turnId, requestId, answer);
      },
      applyClosure: async (reason: RuntimeInteractionClosureReason): Promise<void> => {
        if (!this.closeRequest(turnId, requestId, reason)) {
          throw new RuntimeInteractionInvariantError(
            `Permission closure did not take ${requestId} from turn ${turnId}`,
          );
        }
      },
    });
  }

  private settleCommittedResponse(
    turnId: string,
    requestId: string,
    answer: HostedPermissionAnswer,
  ): void {
    const response: PermissionResponse = {
      requestId,
      decision: answer.decision,
      ...(answer.rememberForTurn !== undefined ? { rememberForTurn: answer.rememberForTurn } : {}),
      ...(answer.reviewer !== undefined ? { reviewer: answer.reviewer } : {}),
      ...(answer.riskLevel !== undefined ? { riskLevel: answer.riskLevel } : {}),
    };
    this.assertValidResponse(response);
    const state = this.turns.get(turnId);
    const parked = this.parked.entries(turnId).find(([id]) => id === requestId)?.[1];
    if (!state || !parked?.hosted) {
      throw new RuntimeInteractionInvariantError(
        `Permission settlement did not exact-take ${requestId} from turn ${turnId}`,
      );
    }
    this.applyResponse(turnId, response, state, parked);
  }

  private assertValidResponse(response: PermissionResponse): void {
    if (
      !response ||
      typeof response.requestId !== 'string' ||
      (response.decision !== 'allow' && response.decision !== 'deny') ||
      (response.rememberForTurn !== undefined && typeof response.rememberForTurn !== 'boolean') ||
      (response.reviewer !== undefined &&
        response.reviewer !== 'user' &&
        response.reviewer !== 'auto_review') ||
      (response.rationale !== undefined && typeof response.rationale !== 'string') ||
      (response.riskLevel !== undefined &&
        !['low', 'medium', 'high', 'critical'].includes(response.riskLevel))
    ) {
      throw new Error('Invalid permission response');
    }
  }

  /**
   * Route a user's response to the parked Promise. Idempotent on stray
   * responses for unknown requestIds (logs and ignores).
   *
   * Returns the resolved ParkedRequest (for the caller to write
   * PermissionDecisionMessage + emit PermissionDecisionAckEvent), or null
   * if the requestId was unknown.
   */
  recordResponse(
    turnId: string,
    response: PermissionResponse,
  ): { category: ToolCategory; toolUseId: string } | null {
    this.assertValidResponse(response);
    const state = this.turns.get(turnId);
    if (!state) return null;
    const parked = this.parked
      .entries(turnId)
      .find(([requestId]) => requestId === response.requestId)?.[1];
    if (!parked) return null;

    if (parked.hosted) {
      if (!parked.hosted.commitStarted) {
        parked.hosted.commitStarted = true;
        const answer = runtimePermissionAnswer(response);
        void parked.hosted.bridge
          .commitPermissionAnswer({
            requestId: response.requestId,
            answer,
          })
          .catch((error: unknown) => {
            if (
              error instanceof RuntimeInteractionAdmissionRejectedError &&
              error.reason === 'run_closed' &&
              error.requestId === response.requestId
            ) {
              return;
            }
            this.rejectRequest(
              turnId,
              response.requestId,
              error instanceof RuntimeInteractionFailStopError ||
                error instanceof RuntimeInteractionInvariantError
                ? error
                : new RuntimeInteractionFailStopError(
                    `Could not confirm the canonical outcome for permission ${response.requestId}`,
                    error,
                  ),
            );
          });
      }
      return { category: parked.category, toolUseId: parked.toolUseId };
    }

    return this.applyResponse(turnId, response, state, parked);
  }

  private applyResponse(
    turnId: string,
    response: PermissionResponse,
    state: TurnState,
    parked: ParkedPermission,
  ): { category: ToolCategory; toolUseId: string } {
    if (
      (parked.additionalProposal || parked.sandboxEscalationProposal) &&
      response.rememberForTurn === true
    ) {
      throw new Error('One-shot permission responses cannot use rememberForTurn');
    }

    if (
      response.decision === 'allow' &&
      response.rememberForTurn &&
      !parked.rememberForTurnAllowed
    ) {
      throw new Error('This permission request cannot be remembered for the turn');
    }

    if (
      response.decision === 'allow' &&
      response.rememberForTurn &&
      parked.rememberForTurnAllowed
    ) {
      state.remembered.add(parked.scopeKey);
      // The user allowed this scope for the whole turn, so other requests
      // already parked under the same scope (e.g. the rest of a parallel
      // browser_* batch) must not each re-prompt. Resolve them now — each
      // tool's own coroutine then emits its own permission_decision_ack, so the
      // UI queue drains without a second click. The current request was already
      // selected explicitly, so the snapshot must not auto-resolve it.
      if (!parked.hosted) {
        for (const [otherId, other] of this.parked.entries(turnId)) {
          if (
            otherId !== response.requestId &&
            other.rememberForTurnAllowed &&
            other.scopeKey === parked.scopeKey
          ) {
            this.parked.resolve(turnId, otherId, {
              requestId: otherId,
              decision: 'allow',
              rememberForTurn: true,
            });
          }
        }
      }
    }

    if (response.decision === 'allow' && parked.additionalProposal) {
      if (state.additionalGrants.has(parked.toolUseId)) {
        throw new Error(`Additional permission grant already exists for tool ${parked.toolUseId}`);
      }
      const issuedAt = this.deps.now();
      state.additionalGrants.set(parked.toolUseId, {
        consumed: false,
        grant: freezeAdditionalPermissionGrant({
          grantId: this.deps.newId(),
          sessionId: parked.sessionId,
          turnId: parked.turnId,
          toolUseId: parked.toolUseId,
          toolName: parked.toolName,
          intentHash: parked.additionalProposal.intentHash,
          permissionsHash: parked.additionalProposal.permissionsHash,
          profile: parked.additionalProposal.profile,
          normalizedPaths: parked.additionalProposal.normalizedPaths,
          risk: parked.additionalProposal.risk,
          issuedAt,
          expiresAt: issuedAt + DEFAULT_ADDITIONAL_PERMISSION_GRANT_TTL_MS,
        }),
      });
    }

    if (response.decision === 'allow' && parked.sandboxEscalationProposal) {
      if (state.sandboxEscalationGrants.has(parked.toolUseId)) {
        throw new Error(`Sandbox escalation grant already exists for tool ${parked.toolUseId}`);
      }
      const issuedAt = this.deps.now();
      const proposal = parked.sandboxEscalationProposal;
      state.sandboxEscalationGrants.set(parked.toolUseId, {
        consumed: false,
        grant: freezeSandboxEscalationGrant({
          grantId: this.deps.newId(),
          sessionId: parked.sessionId,
          turnId: parked.turnId,
          toolUseId: parked.toolUseId,
          toolName: 'Bash',
          intentHash: proposal.intentHash,
          commandHash: proposal.commandHash,
          command: proposal.command,
          cwd: proposal.cwd,
          risk: proposal.risk,
          issuedAt,
          expiresAt: issuedAt + DEFAULT_SANDBOX_ESCALATION_GRANT_TTL_MS,
        }),
      });
    }

    const resolvedResponse: PermissionResponse =
      parked.additionalProposal || parked.sandboxEscalationProposal
        ? {
            requestId: response.requestId,
            decision: response.decision,
            ...(response.reviewer !== undefined ? { reviewer: response.reviewer } : {}),
            ...(response.rationale !== undefined ? { rationale: response.rationale } : {}),
            ...(response.riskLevel !== undefined ? { riskLevel: response.riskLevel } : {}),
          }
        : parked.rememberForTurnAllowed
          ? response
          : { ...response, rememberForTurn: false };
    this.parked.resolve(turnId, response.requestId, resolvedResponse);
    this.finishDeferredTurnClosure(turnId);
    return { category: parked.category, toolUseId: parked.toolUseId };
  }

  /**
   * Fail one parked request without ending the whole turn.
   * Used by runtime-level permission timeouts so late UI responses do not
   * resolve a tool call that has already failed closed.
   */
  expireRequest(
    turnId: string,
    requestId: string,
    reason: string,
  ): { category: ToolCategory; toolUseId: string } | null {
    const metadata = this.parked.entries(turnId).find(([id]) => id === requestId)?.[1];
    if (!metadata) return null;
    const error = metadata.additionalProposal
      ? new AdditionalPermissionError({
          stage: 'approval',
          reason: 'additional_permission_timeout',
          message: reason,
          recoverable: true,
        })
      : metadata.sandboxEscalationProposal
        ? new SandboxEscalationError({
            stage: 'approval',
            reason: 'sandbox_escalation_timeout',
            message: reason,
            recoverable: true,
          })
        : new Error(reason);
    const parked = this.parked.reject(turnId, requestId, error);
    this.finishDeferredTurnClosure(turnId);
    if (!parked) return null;
    return { category: parked.category, toolUseId: parked.toolUseId };
  }

  closeRequest(
    turnId: string,
    requestId: string,
    reason: RuntimeInteractionClosureReason,
    message = `Permission request ${requestId} closed: ${reason}`,
  ): { category: ToolCategory; toolUseId: string } | null {
    if (reason === 'timed_out') return this.expireRequest(turnId, requestId, message);
    const parked = this.parked.reject(
      turnId,
      requestId,
      new RuntimeInteractionClosedError(requestId, reason),
    );
    this.finishDeferredTurnClosure(turnId);
    return parked ? { category: parked.category, toolUseId: parked.toolUseId } : null;
  }

  rejectRequest(
    turnId: string,
    requestId: string,
    error: Error,
  ): { category: ToolCategory; toolUseId: string } | null {
    const parked = this.parked.reject(turnId, requestId, error);
    this.finishDeferredTurnClosure(turnId);
    return parked ? { category: parked.category, toolUseId: parked.toolUseId } : null;
  }

  /** Test/debug accessor. */
  pendingCount(turnId: string): number {
    return this.parked.pendingCount(turnId);
  }

  consumeAdditionalPermissionGrant(input: {
    sessionId: string;
    turnId: string;
    toolUseId: string;
    toolName: string;
    intentHash: string;
  }): AdditionalPermissionGrant | undefined {
    const state = this.turns.get(input.turnId);
    const pending = state?.additionalGrants.get(input.toolUseId);
    if (!pending) return undefined;
    if (pending.consumed) {
      throw new AdditionalPermissionError({
        stage: 'consume',
        reason: 'grant_already_consumed',
      });
    }

    const grant = pending.grant;
    if (grant.expiresAt <= this.deps.now()) {
      state!.additionalGrants.delete(input.toolUseId);
      throw new AdditionalPermissionError({
        stage: 'consume',
        reason: 'grant_expired',
      });
    }
    if (
      grant.sessionId !== input.sessionId ||
      grant.turnId !== input.turnId ||
      grant.toolUseId !== input.toolUseId ||
      grant.toolName !== input.toolName ||
      grant.intentHash !== input.intentHash
    ) {
      throw new AdditionalPermissionError({
        stage: 'consume',
        reason: 'grant_intent_mismatch',
      });
    }

    pending.consumed = true;
    return grant;
  }

  consumeSandboxEscalationGrant(input: {
    sessionId: string;
    turnId: string;
    toolUseId: string;
    toolName: string;
    intentHash: string;
    command: string;
    cwd: string;
  }): SandboxEscalationGrant | undefined {
    const state = this.turns.get(input.turnId);
    const pending = state?.sandboxEscalationGrants.get(input.toolUseId);
    if (!pending) return undefined;
    if (pending.consumed) {
      throw new SandboxEscalationError({
        stage: 'consume',
        reason: 'sandbox_escalation_grant_consumed',
      });
    }
    const grant = pending.grant;
    if (grant.expiresAt <= this.deps.now()) {
      state!.sandboxEscalationGrants.delete(input.toolUseId);
      throw new SandboxEscalationError({
        stage: 'consume',
        reason: 'sandbox_escalation_grant_expired',
      });
    }
    if (
      grant.sessionId !== input.sessionId ||
      grant.turnId !== input.turnId ||
      grant.toolUseId !== input.toolUseId ||
      grant.toolName !== input.toolName ||
      grant.intentHash !== input.intentHash
    ) {
      throw new SandboxEscalationError({
        stage: 'consume',
        reason: 'sandbox_escalation_intent_mismatch',
      });
    }
    if (grant.command !== input.command) {
      throw new SandboxEscalationError({
        stage: 'consume',
        reason: 'sandbox_escalation_command_mismatch',
      });
    }
    if (grant.cwd !== input.cwd) {
      throw new SandboxEscalationError({
        stage: 'consume',
        reason: 'sandbox_escalation_cwd_mismatch',
      });
    }
    pending.consumed = true;
    return grant;
  }

  private requireTurn(turnId: string): TurnState {
    let state = this.turns.get(turnId);
    if (!state) {
      // Auto-begin: callers may forget. This is a soft guarantee.
      state = {
        turnId,
        remembered: new Set(),
        rememberScopeIds: new Map(),
        additionalGrants: new Map(),
        sandboxEscalationGrants: new Map(),
      };
      this.turns.set(turnId, state);
      this.parked.beginTurn(turnId);
    }
    return state;
  }

  private finishDeferredTurnClosure(turnId: string): void {
    if (!this.deferredTurnClosures.has(turnId) || this.parked.pendingCount(turnId) !== 0) return;
    this.deferredTurnClosures.delete(turnId);
    this.parked.endTurn(
      turnId,
      (requestId) =>
        new RuntimeInteractionInvariantError(
          `Hosted permission ${requestId} escaped exact Run closure`,
        ),
    );
    this.turns.delete(turnId);
  }

  private rememberScopeId(state: TurnState, scopeKey: string, requestId: string): string {
    const existing = state.rememberScopeIds.get(scopeKey);
    if (existing) return existing;
    const id = createHash('sha256').update(requestId, 'utf8').digest('hex');
    state.rememberScopeIds.set(scopeKey, id);
    return id;
  }
}

function runtimePermissionAnswer(response: PermissionResponse): HostedPermissionAnswer {
  return {
    decision: response.decision,
    ...(response.rememberForTurn !== undefined
      ? { rememberForTurn: response.rememberForTurn }
      : {}),
    ...(response.reviewer !== undefined ? { reviewer: response.reviewer } : {}),
    ...(response.riskLevel !== undefined ? { riskLevel: response.riskLevel } : {}),
  };
}

function snapshotPermissionArgs(value: unknown): unknown {
  return snapshotPermissionValue(value, new WeakSet<object>());
}

function snapshotPermissionValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) throw new Error('Permission arguments must not contain cycles');
  seen.add(value);
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => snapshotPermissionValue(entry, seen)));
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new Error(`Permission argument ${key} must be a plain data property`);
    }
    output[key] = snapshotPermissionValue(descriptor.value, seen);
  }
  return Object.freeze(output);
}

// ============================================================================
// Default deps factory (Node / Bun)
// ============================================================================

export function createDefaultPermissionEngineDeps(): PermissionEngineDeps {
  return {
    newId: () => crypto.randomUUID(),
    now: () => Date.now(),
  };
}
