import type { CuAction } from '@maka/core/computer-use';
import {
  convertOpenAIComputerAction,
  isOpenAIComputerActionSafeByDefault,
  type OpenAIComputerAction,
  type OpenAIComputerActionConversion,
} from './openai-computer-actions.js';
import {
  createOpenAIComputerContinuationRequest,
  createOpenAIComputerInitialRequest,
  decodeOpenAIComputerResponse,
  type OpenAIComputerCall,
  type OpenAIComputerDialect,
  type OpenAIComputerRequest,
  type OpenAIComputerResponse,
  type OpenAIComputerSafetyCheck,
  type OpenAIComputerScreenshot,
} from './openai-computer-codec.js';
import type { CuDispatchOutcome, CuRunResult } from './computer-use-types.js';

export const DEFAULT_OPENAI_COMPUTER_MAX_TURNS = 12;
export const DEFAULT_OPENAI_COMPUTER_MAX_ACTIONS_PER_CALL = 8;
export const DEFAULT_OPENAI_COMPUTER_DEADLINE_MS = 120_000;

export interface OpenAIComputerTransport {
  create(request: OpenAIComputerRequest, signal: AbortSignal): Promise<unknown>;
}

export interface OpenAIComputerExecutor {
  execute(action: CuAction, signal: AbortSignal): Promise<CuRunResult>;
}

export interface OpenAIComputerScreenshotProvider {
  capture(signal: AbortSignal): Promise<OpenAIComputerScreenshot>;
}

export type OpenAIComputerLoopResult =
  | { status: 'completed'; response: OpenAIComputerResponse; turns: number }
  | {
      status: 'safety_blocked';
      response: OpenAIComputerResponse;
      call: OpenAIComputerCall;
      checks: OpenAIComputerSafetyCheck[];
      turns: number;
    }
  | {
      status: 'unsupported_action';
      response: OpenAIComputerResponse;
      call: OpenAIComputerCall;
      actionIndex: number;
      failure: Extract<OpenAIComputerActionConversion, { ok: false }>;
      turns: number;
    }
  | {
      status: 'execution_failed';
      response: OpenAIComputerResponse;
      call: OpenAIComputerCall;
      actionIndex: number;
      outcome: Extract<CuDispatchOutcome, { ok: false }>;
      completedActions: number;
      turns: number;
    }
  | {
      status: 'outcome_unknown';
      response: OpenAIComputerResponse;
      call: OpenAIComputerCall;
      actionIndex: number;
      outcome: Extract<CuDispatchOutcome, { ok: false }>;
      completedActions: number;
      screenshot?: OpenAIComputerScreenshot;
      turns: number;
    }
  | {
      status: 'max_turns_reached';
      response: OpenAIComputerResponse;
      call: OpenAIComputerCall;
      screenshot: OpenAIComputerScreenshot;
      continuationRequest: OpenAIComputerRequest;
      turns: number;
    };

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('openai_computer_loop_aborted');
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid_openai_computer_${label}: expected positive integer`);
  }
  return value;
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid_openai_computer_${label}: expected positive finite number`);
  }
  return value;
}

function outcomeIsUnknown(
  outcome: Extract<CuDispatchOutcome, { ok: false }>,
  completedActions: number,
): boolean {
  return (
    outcome.error === 'outcome_unknown' ||
    completedActions > 0 ||
    (outcome.completedSubSteps ?? 0) > 0
  );
}

export async function runOpenAIComputerLoop(input: {
  dialect: OpenAIComputerDialect;
  model: string;
  prompt: string;
  transport: OpenAIComputerTransport;
  executor: OpenAIComputerExecutor;
  screenshot: OpenAIComputerScreenshotProvider;
  signal?: AbortSignal;
  maxTurns?: number;
  maxActionsPerCall?: number;
  deadlineMs?: number;
  display?: {
    widthPx: number;
    heightPx: number;
    environment: 'browser' | 'mac' | 'windows' | 'linux';
  };
  acknowledgeSafetyChecks?: (
    checks: OpenAIComputerSafetyCheck[],
    call: OpenAIComputerCall,
    signal: AbortSignal,
  ) => Promise<boolean>;
  allowAction?: (
    action: OpenAIComputerAction,
    context: { turn: number; actionIndex: number; call: OpenAIComputerCall },
  ) => boolean | Promise<boolean>;
}): Promise<OpenAIComputerLoopResult> {
  const maxTurns = positiveInteger(
    input.maxTurns ?? DEFAULT_OPENAI_COMPUTER_MAX_TURNS,
    'max_turns',
  );
  const maxActionsPerCall = positiveInteger(
    input.maxActionsPerCall ?? DEFAULT_OPENAI_COMPUTER_MAX_ACTIONS_PER_CALL,
    'max_actions_per_call',
  );
  const deadlineMs = positiveFinite(
    input.deadlineMs ?? DEFAULT_OPENAI_COMPUTER_DEADLINE_MS,
    'deadline_ms',
  );
  const controller = new AbortController();
  let deadlineExceeded = false;
  const onAbort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener('abort', onAbort, { once: true });
  const deadline = setTimeout(() => {
    deadlineExceeded = true;
    controller.abort(new Error('openai_computer_loop_deadline_exceeded'));
  }, deadlineMs);
  const signal = controller.signal;
  let request = createOpenAIComputerInitialRequest(input);

  try {
    for (let turns = 1; turns <= maxTurns; turns += 1) {
      throwIfAborted(signal);
      const response = decodeOpenAIComputerResponse(
        await input.transport.create(request, signal),
        input.dialect,
      );
      if (response.status === 'failed' || response.error) {
        throw new Error(
          `openai_computer_response_failed: ${
            response.error?.code ?? response.error?.type ?? response.status
          }: ${response.error?.message ?? 'request failed'}`,
        );
      }
      if (response.status !== 'completed') {
        throw new Error(`openai_computer_response_not_completed: ${response.status}`);
      }
      if (response.calls.length === 0) {
        return { status: 'completed', response, turns };
      }
      if (response.calls.length !== 1) {
        throw new Error(
          `unsupported_openai_computer_parallel_calls: received ${response.calls.length}`,
        );
      }

      const call = response.calls[0];
      if (call.status !== 'completed') {
        throw new Error(`openai_computer_call_not_completed: ${call.status}`);
      }
      if (call.actions.length > maxActionsPerCall) {
        throw new Error(
          `openai_computer_action_batch_limit_exceeded: ` +
            `${call.actions.length} > ${maxActionsPerCall}`,
        );
      }
      let acknowledgedSafetyChecks: OpenAIComputerSafetyCheck[] | undefined;
      if (call.pendingSafetyChecks.length > 0) {
        const acknowledged =
          (await input.acknowledgeSafetyChecks?.(call.pendingSafetyChecks, call, signal)) ?? false;
        if (!acknowledged) {
          return {
            status: 'safety_blocked',
            response,
            call,
            checks: call.pendingSafetyChecks,
            turns,
          };
        }
        acknowledgedSafetyChecks = call.pendingSafetyChecks;
      }

      const converted: CuAction[][] = [];
      for (let actionIndex = 0; actionIndex < call.actions.length; actionIndex += 1) {
        const action = call.actions[actionIndex];
        const allowed = input.allowAction
          ? await input.allowAction(action, { turn: turns, actionIndex, call })
          : isOpenAIComputerActionSafeByDefault(action);
        if (!allowed) {
          return {
            status: 'unsupported_action',
            response,
            call,
            actionIndex,
            failure: {
              ok: false,
              code: 'unsupported_action_policy',
              message:
                `OpenAI computer action '${action.type}' is disabled by the current ` +
                'physical-input safety policy',
            },
            turns,
          };
        }
        const conversion = convertOpenAIComputerAction(action);
        if (!conversion.ok) {
          return {
            status: 'unsupported_action',
            response,
            call,
            actionIndex,
            failure: conversion,
            turns,
          };
        }
        converted.push(conversion.actions);
      }

      let completedActions = 0;
      for (let actionIndex = 0; actionIndex < converted.length; actionIndex += 1) {
        for (const action of converted[actionIndex]) {
          throwIfAborted(signal);
          const execution = await input.executor.execute(action, signal);
          if (!execution.outcome.ok) {
            const unknown = outcomeIsUnknown(execution.outcome, completedActions);
            let screenshot: OpenAIComputerScreenshot | undefined;
            if (unknown) {
              screenshot = execution.screenshot
                ? {
                    base64: execution.screenshot.base64,
                    mimeType: execution.screenshot.mimeType,
                  }
                : await input.screenshot.capture(signal);
            }
            return {
              status: unknown ? 'outcome_unknown' : 'execution_failed',
              response,
              call,
              actionIndex,
              outcome: execution.outcome,
              completedActions,
              ...(screenshot ? { screenshot } : {}),
              turns,
            };
          }
          completedActions += 1;
        }
      }

      const screenshot = await input.screenshot.capture(signal);
      const continuationRequest = createOpenAIComputerContinuationRequest({
        dialect: input.dialect,
        model: input.model,
        previousResponseId: response.id,
        callId: call.callId,
        screenshot,
        acknowledgedSafetyChecks,
        display: input.display,
      });
      if (turns === maxTurns) {
        return {
          status: 'max_turns_reached',
          response,
          call,
          screenshot,
          continuationRequest,
          turns,
        };
      }
      request = continuationRequest;
    }
    throw new Error('openai_computer_loop_unreachable');
  } catch (error) {
    if (deadlineExceeded) {
      throw new Error('openai_computer_loop_deadline_exceeded', { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    input.signal?.removeEventListener('abort', onAbort);
  }
}
