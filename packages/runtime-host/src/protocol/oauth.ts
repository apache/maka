import {
  requireEntityId,
  requireExactRecord,
  requireRecord,
  requireShapedRecord,
  requireString,
} from './codec.js';
import type { QuotaSnapshot, QuotaWindow } from '@maka/core/oauth-subscription';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const OAUTH_PRESENTATION_SERVICE_ID = 'oauth_presentation';
export const OAUTH_PRESENTATION_SERVICE_VERSION = '1';
export const OAUTH_PRESENTATION_AUTHORIZATION_CODE_MAX_LENGTH = 16_384;
export const OAUTH_PRESENTATION_URL_MAX_LENGTH = 8_192;
export const OAUTH_PRESENTATION_STATE_HINT_MAX_LENGTH = 1_024;
export const OAUTH_LOGIN_PROVIDERS = ['claude-subscription', 'openai-codex', 'xai-oauth'] as const;
export const OAUTH_LOGIN_PHASES = [
  'awaiting_authorization',
  'exchanging',
  'committing',
  'authenticated',
  'cancelled',
  'failed',
] as const;
export const OAUTH_LOGIN_FAILURE_CODES = [
  'capability_unavailable',
  'authorization_failed',
  'provider_rejected',
  'credential_changed',
  'persistence_failed',
  'internal_failure',
] as const;

const COMMON_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'internal_failure',
] as const;
const START_ERRORS = [
  ...COMMON_ERRORS,
  'operation_conflict',
  'capability_unavailable',
  'not_found',
  'persistence_failed',
] as const;
const ATTEMPT_ERRORS = [...COMMON_ERRORS, 'not_found'] as const;
const ACCOUNT_USAGE_ERRORS = [...COMMON_ERRORS, 'not_found', 'persistence_failed'] as const;

export type OAuthLoginProvider = (typeof OAUTH_LOGIN_PROVIDERS)[number];
export type OAuthLoginPhase = (typeof OAUTH_LOGIN_PHASES)[number];
export type OAuthLoginFailureCode = (typeof OAUTH_LOGIN_FAILURE_CODES)[number];
export type OAuthPresentationMethod = 'open_external' | 'request_authorization_code';

export type OAuthPresentationRequest =
  | {
      readonly method: 'open_external';
      readonly url: string;
      readonly stateHint?: string;
    }
  | {
      readonly method: 'request_authorization_code';
      readonly url: string;
      readonly stateHint: string;
    };

export type OAuthPresentationResult =
  | { readonly kind: 'presented' }
  | { readonly kind: 'authorization_code'; readonly authorizationCode: string };

export type OAuthPresentationResultForMethod<Method extends OAuthPresentationMethod> =
  Method extends 'open_external'
    ? Extract<OAuthPresentationResult, { readonly kind: 'presented' }>
    : Extract<OAuthPresentationResult, { readonly kind: 'authorization_code' }>;

export interface OAuthLoginProjection {
  readonly attemptId: string;
  readonly connectionId: string;
  readonly provider: OAuthLoginProvider;
  readonly phase: OAuthLoginPhase;
  readonly failure?: OAuthLoginFailureCode;
}

export interface OAuthLoginStartInput {
  readonly attemptId: string;
  readonly connectionId: string;
}

export interface OAuthLoginAttemptInput {
  readonly attemptId: string;
}

export interface OAuthAccountUsageFetchInput {
  readonly connectionId: string;
}

export type OAuthAccountUsageUnavailableReason =
  | 'unsupported_provider'
  | 'credential_unavailable'
  | 'provider_unavailable'
  | 'invalid_response';

export type OAuthAccountUsageFetchResult =
  | {
      readonly kind: 'available';
      readonly provider: OAuthLoginProvider;
      readonly quota: QuotaSnapshot;
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: OAuthAccountUsageUnavailableReason;
    };

export const OAUTH_OPERATION_SPECS = {
  'oauth.login.start': defineOperation<
    OAuthLoginStartInput,
    OAuthLoginProjection,
    (typeof START_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: START_ERRORS,
    decodeInput: decodeOAuthLoginStartInput,
    decodeOutput: decodeOAuthLoginProjection,
  }),
  'oauth.login.query': defineOperation<
    OAuthLoginAttemptInput,
    OAuthLoginProjection,
    (typeof ATTEMPT_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: ATTEMPT_ERRORS,
    decodeInput: decodeOAuthLoginAttemptInput,
    decodeOutput: decodeOAuthLoginProjection,
  }),
  'oauth.login.cancel': defineOperation<
    OAuthLoginAttemptInput,
    OAuthLoginProjection,
    (typeof ATTEMPT_ERRORS)[number]
  >({
    mode: 'control',
    availability: 'ready',
    errors: ATTEMPT_ERRORS,
    decodeInput: decodeOAuthLoginAttemptInput,
    decodeOutput: decodeOAuthLoginProjection,
  }),
  'oauth.account.usage.fetch': defineOperation<
    OAuthAccountUsageFetchInput,
    OAuthAccountUsageFetchResult,
    (typeof ACCOUNT_USAGE_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: ACCOUNT_USAGE_ERRORS,
    decodeInput: decodeOAuthAccountUsageFetchInput,
    decodeOutput: decodeOAuthAccountUsageFetchResult,
  }),
} as const;

export function decodeOAuthLoginStartInput(value: unknown): OAuthLoginStartInput {
  const input = requireExactRecord(value, 'OAuth login start input', ['attemptId', 'connectionId']);
  return {
    attemptId: requireEntityId(input.attemptId, 'attemptId'),
    connectionId: requireEntityId(input.connectionId, 'connectionId'),
  };
}

export function decodeOAuthLoginAttemptInput(value: unknown): OAuthLoginAttemptInput {
  const input = requireExactRecord(value, 'OAuth login attempt input', ['attemptId']);
  return { attemptId: requireEntityId(input.attemptId, 'attemptId') };
}

export function decodeOAuthAccountUsageFetchInput(value: unknown): OAuthAccountUsageFetchInput {
  const input = requireExactRecord(value, 'OAuth account usage input', ['connectionId']);
  return { connectionId: requireEntityId(input.connectionId, 'connectionId') };
}

export function decodeOAuthAccountUsageFetchResult(value: unknown): OAuthAccountUsageFetchResult {
  const result = requireRecord(value, 'OAuth account usage result');
  if (result.kind === 'available') {
    const available = requireExactRecord(result, 'OAuth account usage result', [
      'kind',
      'provider',
      'quota',
    ]);
    return {
      kind: 'available',
      provider: oauthLoginProvider(available.provider),
      quota: quotaSnapshot(available.quota),
    };
  }
  const unavailable = requireExactRecord(result, 'OAuth account usage result', ['kind', 'reason']);
  if (unavailable.kind !== 'unavailable') {
    throw invalidProtocolFrame('Invalid OAuth account usage result');
  }
  return { kind: 'unavailable', reason: accountUsageUnavailableReason(unavailable.reason) };
}

export function decodeOAuthLoginProjection(value: unknown): OAuthLoginProjection {
  const projection = requireRecord(value, 'OAuth login projection');
  const phase = oauthLoginPhase(projection.phase);
  const exact = requireExactRecord(
    projection,
    'OAuth login projection',
    phase === 'failed'
      ? ['attemptId', 'connectionId', 'provider', 'phase', 'failure']
      : ['attemptId', 'connectionId', 'provider', 'phase'],
  );
  return {
    attemptId: requireEntityId(exact.attemptId, 'attemptId'),
    connectionId: requireEntityId(exact.connectionId, 'connectionId'),
    provider: oauthLoginProvider(exact.provider),
    phase,
    ...(phase === 'failed' ? { failure: oauthLoginFailure(exact.failure) } : {}),
  };
}

export function decodeOAuthPresentationRequest(
  method: unknown,
  value: unknown,
): OAuthPresentationRequest {
  if (method === 'open_external') {
    const input = requireShapedRecord(value, 'OAuth presentation input', ['url'], ['stateHint']);
    return {
      method,
      url: requireString(input.url, 'OAuth presentation URL', OAUTH_PRESENTATION_URL_MAX_LENGTH),
      ...(input.stateHint === undefined
        ? {}
        : {
            stateHint: requireString(
              input.stateHint,
              'OAuth presentation state hint',
              OAUTH_PRESENTATION_STATE_HINT_MAX_LENGTH,
            ),
          }),
    };
  }
  if (method === 'request_authorization_code') {
    const input = requireExactRecord(value, 'OAuth presentation input', ['url', 'stateHint']);
    return {
      method,
      url: requireString(input.url, 'OAuth presentation URL', OAUTH_PRESENTATION_URL_MAX_LENGTH),
      stateHint: requireString(
        input.stateHint,
        'OAuth presentation state hint',
        OAUTH_PRESENTATION_STATE_HINT_MAX_LENGTH,
      ),
    };
  }
  throw invalidProtocolFrame('Invalid OAuth presentation method');
}

export function decodeOAuthPresentationResult(
  method: 'open_external',
  value: unknown,
): OAuthPresentationResultForMethod<'open_external'>;
export function decodeOAuthPresentationResult(
  method: 'request_authorization_code',
  value: unknown,
): OAuthPresentationResultForMethod<'request_authorization_code'>;
export function decodeOAuthPresentationResult(
  method: OAuthPresentationMethod,
  value: unknown,
): OAuthPresentationResult;
export function decodeOAuthPresentationResult(
  method: OAuthPresentationMethod,
  value: unknown,
): OAuthPresentationResult {
  if (method === 'open_external') {
    const result = requireExactRecord(value, 'OAuth presentation result', ['kind']);
    if (result.kind !== 'presented') {
      throw invalidProtocolFrame('Invalid OAuth presentation result');
    }
    return { kind: result.kind };
  }
  const result = requireExactRecord(value, 'OAuth presentation result', [
    'kind',
    'authorizationCode',
  ]);
  if (result.kind !== 'authorization_code') {
    throw invalidProtocolFrame('Invalid OAuth presentation result');
  }
  return {
    kind: result.kind,
    authorizationCode: requireString(
      result.authorizationCode,
      'OAuth presentation authorization code',
      OAUTH_PRESENTATION_AUTHORIZATION_CODE_MAX_LENGTH,
    ),
  };
}

function oauthLoginProvider(value: unknown): OAuthLoginProvider {
  if (typeof value !== 'string' || !OAUTH_LOGIN_PROVIDERS.includes(value as OAuthLoginProvider)) {
    throw invalidProtocolFrame('Invalid OAuth login provider');
  }
  return value as OAuthLoginProvider;
}

function oauthLoginPhase(value: unknown): OAuthLoginPhase {
  if (typeof value !== 'string' || !OAUTH_LOGIN_PHASES.includes(value as OAuthLoginPhase)) {
    throw invalidProtocolFrame('Invalid OAuth login phase');
  }
  return value as OAuthLoginPhase;
}

function oauthLoginFailure(value: unknown): OAuthLoginFailureCode {
  if (
    typeof value !== 'string' ||
    !OAUTH_LOGIN_FAILURE_CODES.includes(value as OAuthLoginFailureCode)
  ) {
    throw invalidProtocolFrame('Invalid OAuth login failure');
  }
  return value as OAuthLoginFailureCode;
}

function accountUsageUnavailableReason(value: unknown): OAuthAccountUsageUnavailableReason {
  if (
    value !== 'unsupported_provider' &&
    value !== 'credential_unavailable' &&
    value !== 'provider_unavailable' &&
    value !== 'invalid_response'
  ) {
    throw invalidProtocolFrame('Invalid OAuth account usage unavailability reason');
  }
  return value;
}

function quotaSnapshot(value: unknown): QuotaSnapshot {
  const record = requireShapedRecord(
    value,
    'OAuth account quota',
    ['fetchedAt'],
    ['fiveHour', 'sevenDay'],
  );
  return {
    ...(record.fiveHour === undefined ? {} : { fiveHour: quotaWindow(record.fiveHour) }),
    ...(record.sevenDay === undefined ? {} : { sevenDay: quotaWindow(record.sevenDay) }),
    fetchedAt: safeInteger(record.fetchedAt, 'quota fetchedAt'),
  };
}

function quotaWindow(value: unknown): QuotaWindow {
  const record = requireExactRecord(value, 'OAuth account quota window', [
    'utilization',
    'resetsAt',
  ]);
  const utilization = safeInteger(record.utilization, 'quota utilization');
  if (utilization > 100) throw invalidProtocolFrame('Invalid quota utilization');
  return {
    utilization,
    resetsAt: requireString(record.resetsAt, 'quota reset timestamp', 128),
  };
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as number;
}
