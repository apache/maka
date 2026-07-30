import {
  COMPUTER_USE_EFFECTS,
  isComputerUseErrorCode,
  type ComputerUseDispatchTier,
  type ComputerUseEffect,
} from '@maka/core';
import type { CuDispatchEvidence, CuDispatchOutcome } from '@maka/runtime';

export interface JsonRpcToolResult {
  content?: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

const effects = new Set<string>(COMPUTER_USE_EFFECTS);

function dispatchEvidence(
  structuredContent: Record<string, unknown> | undefined,
): CuDispatchEvidence | undefined {
  if (!structuredContent) return undefined;
  const path = typeof structuredContent.path === 'string' ? structuredContent.path : undefined;
  const effect =
    typeof structuredContent.effect === 'string' && effects.has(structuredContent.effect)
      ? (structuredContent.effect as ComputerUseEffect)
      : undefined;
  const reason =
    typeof structuredContent.reason === 'string' ? structuredContent.reason : undefined;
  return path === undefined && effect === undefined && reason === undefined
    ? undefined
    : {
        ...(path === undefined ? {} : { path }),
        ...(effect === undefined ? {} : { effect }),
        ...(reason === undefined ? {} : { reason }),
      };
}

function dispatchTier(path: string | undefined): ComputerUseDispatchTier {
  if (path === 'ax') return 'ax';
  if (path === 'cdp' || path === 'page') return 'semantic-background';
  return 'coordinate-background';
}

function verification(
  structuredContent: Record<string, unknown> | undefined,
  effect: ComputerUseEffect | undefined,
): boolean | undefined {
  if (typeof structuredContent?.verified === 'boolean') {
    return structuredContent.verified;
  }
  if (effect === 'confirmed') return true;
  if (effect === 'unverifiable' || effect === 'suspected_noop') return false;
  return undefined;
}

function resultText(result: JsonRpcToolResult | undefined, fallback: string): string {
  return (
    result?.content?.find(
      (content): content is typeof content & { text: string } =>
        content.type === 'text' && typeof content.text === 'string',
    )?.text ?? fallback
  );
}

/**
 * `kAXErrorActionUnsupported`. AppKit returns it when an element has no such
 * action — pressing a text area, for instance, which is not a thing you do to
 * a text area.
 */
const AX_ACTION_UNSUPPORTED = -25206;

/**
 * A code for a driver error that Maka's enum does not name.
 *
 * This used to be `capture_failed` for everything, which is a specific claim —
 * "the screenshot did not work" — and it was wrong for every error that was not
 * about capture. Watched on a real desktop chain: `click_element` on a
 * `AXTextArea` came back "capture_failed: AX action failed:
 * AXUIElementPerformAction(AXPress) returned -25206". Nothing about capture had
 * failed. The model spent seven tool calls re-observing and retrying the same
 * click, because the code told it the failure was transient and the message
 * that said otherwise was behind it.
 *
 * `unsupported_action` is the truthful reading of that one, and it is already
 * in the enum. Everything still unrecognised stays `capture_failed` rather than
 * being widened into a second catch-all — a code that means one thing should
 * not quietly grow to mean anything.
 */
function classifyUnmappedDriverError(message: string): 'unsupported_action' | 'capture_failed' {
  return message.includes(String(AX_ACTION_UNSUPPORTED)) || /action[ _]?unsupported/i.test(message)
    ? 'unsupported_action'
    : 'capture_failed';
}

export function normalizeCuaDriverOutcome(
  result: JsonRpcToolResult | undefined,
): CuDispatchOutcome {
  if (!result) {
    return {
      ok: false,
      error: 'capture_failed',
      message: 'cua-driver returned no result',
    };
  }

  const structuredContent = result.structuredContent;
  const evidence = dispatchEvidence(structuredContent);
  const path = evidence?.path;

  if (result.isError) {
    const rawError = structuredContent?.error;
    const message = resultText(result, 'cua-driver reported an error');
    return {
      ok: false,
      error: isComputerUseErrorCode(rawError) ? rawError : classifyUnmappedDriverError(message),
      message,
      ...(evidence ? { evidence } : {}),
    };
  }

  if (evidence?.effect === 'suspected_noop') {
    return {
      ok: false,
      error: 'capture_failed',
      message: resultText(result, 'cua-driver reported a suspected no-op'),
      evidence,
    };
  }

  if (path?.endsWith('_fg')) {
    return {
      ok: false,
      error: 'unsupported_action',
      message: 'cua-driver used a foreground dispatch path that Maka forbids',
      ...(evidence ? { evidence } : {}),
    };
  }

  const verified = verification(structuredContent, evidence?.effect);
  return {
    ok: true,
    tier: dispatchTier(path),
    ...(verified === undefined ? {} : { verified }),
    ...(evidence ? { evidence } : {}),
  };
}
