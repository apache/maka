import type { ModelInfo } from '@maka/core/llm-connections';
import { decodeConnectionModel, decodeConnectionModelId } from '@maka/core/runtime-policy';
import {
  requireEntityId,
  requireExactRecord,
  requireRecord,
  requireShapedRecord,
  requireString,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

const COMMON_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'not_found',
  'persistence_failed',
  'internal_failure',
] as const;

export const BEDROCK_SSO_LOGIN_PHASES = [
  'awaiting_authorization',
  'authenticated',
  'cancelled',
  'failed',
] as const;
export type BedrockSsoLoginPhase = (typeof BEDROCK_SSO_LOGIN_PHASES)[number];

export interface BedrockSsoLoginProjection {
  readonly attemptId: string;
  readonly phase: BedrockSsoLoginPhase;
  readonly userCode?: string;
  readonly failure?: 'authorization_failed' | 'provider_rejected' | 'internal_failure';
}

export interface BedrockSsoAccountProjection {
  readonly accountId: string;
  readonly accountName?: string;
  readonly emailAddress?: string;
}

export const BEDROCK_SSO_OPERATION_SPECS = {
  'bedrock.sso.login.start': defineOperation<
    { attemptId: string; ssoStartUrl: string; ssoRegion: string; region: string },
    BedrockSsoLoginProjection,
    (typeof COMMON_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: COMMON_ERRORS,
    decodeInput: decodeLoginStart,
    decodeOutput: decodeLoginProjection,
  }),
  'bedrock.sso.login.query': defineOperation<
    { attemptId: string },
    BedrockSsoLoginProjection,
    (typeof COMMON_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: COMMON_ERRORS,
    decodeInput: decodeAttempt,
    decodeOutput: decodeLoginProjection,
  }),
  'bedrock.sso.login.cancel': defineOperation<
    { attemptId: string },
    BedrockSsoLoginProjection,
    (typeof COMMON_ERRORS)[number]
  >({
    mode: 'control',
    availability: 'ready',
    errors: COMMON_ERRORS,
    decodeInput: decodeAttempt,
    decodeOutput: decodeLoginProjection,
  }),
  'bedrock.sso.accounts.list': defineOperation<
    { attemptId: string },
    { accounts: readonly BedrockSsoAccountProjection[] },
    (typeof COMMON_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: COMMON_ERRORS,
    decodeInput: decodeAttempt,
    decodeOutput: decodeAccounts,
  }),
  'bedrock.sso.roles.list': defineOperation<
    { attemptId: string; accountId: string },
    { roles: readonly string[] },
    (typeof COMMON_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: COMMON_ERRORS,
    decodeInput: decodeRolesInput,
    decodeOutput: decodeRoles,
  }),
  'bedrock.sso.models.fetch': defineOperation<
    { attemptId: string; accountId: string; roleName: string; manualModelIds: readonly string[] },
    { models: readonly ModelInfo[] },
    (typeof COMMON_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: COMMON_ERRORS,
    decodeInput: decodeModelsInput,
    decodeOutput: decodeModels,
  }),
  'bedrock.sso.onboarding.commit': defineOperation<
    { attemptId: string; enabledModelIds: readonly string[] },
    { connectionId: string; slug: string },
    (typeof COMMON_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: COMMON_ERRORS,
    decodeInput: decodeCommitInput,
    decodeOutput: decodeCommitOutput,
  }),
} as const;

function decodeLoginStart(value: unknown) {
  const input = requireExactRecord(value, 'Bedrock SSO login start', [
    'attemptId',
    'ssoStartUrl',
    'ssoRegion',
    'region',
  ]);
  return {
    attemptId: requireEntityId(input.attemptId, 'attemptId'),
    ssoStartUrl: requireString(input.ssoStartUrl, 'ssoStartUrl', 2_048),
    ssoRegion: requireString(input.ssoRegion, 'ssoRegion', 64),
    region: requireString(input.region, 'region', 64),
  };
}

function decodeAttempt(value: unknown) {
  const input = requireExactRecord(value, 'Bedrock SSO attempt', ['attemptId']);
  return { attemptId: requireEntityId(input.attemptId, 'attemptId') };
}

function decodeLoginProjection(value: unknown): BedrockSsoLoginProjection {
  const input = requireRecord(value, 'Bedrock SSO login projection');
  const phase = input.phase;
  if (!(BEDROCK_SSO_LOGIN_PHASES as readonly unknown[]).includes(phase)) {
    throw invalidProtocolFrame('Invalid Bedrock SSO login phase');
  }
  const exact = requireExactRecord(input, 'Bedrock SSO login projection', [
    'attemptId',
    'phase',
    ...(phase === 'awaiting_authorization' ? ['userCode'] : []),
    ...(phase === 'failed' ? ['failure'] : []),
  ]);
  const failure = exact.failure;
  if (
    failure !== undefined &&
    failure !== 'authorization_failed' &&
    failure !== 'provider_rejected' &&
    failure !== 'internal_failure'
  ) {
    throw invalidProtocolFrame('Invalid Bedrock SSO login failure');
  }
  return {
    attemptId: requireEntityId(exact.attemptId, 'attemptId'),
    phase: phase as BedrockSsoLoginPhase,
    ...(exact.userCode === undefined
      ? {}
      : { userCode: requireString(exact.userCode, 'userCode', 1_024) }),
    ...(failure === undefined ? {} : { failure }),
  };
}

function decodeAccounts(value: unknown) {
  assertBoundedProjection(value, 256 * 1024, 'Bedrock SSO accounts');
  const input = requireExactRecord(value, 'Bedrock SSO accounts', ['accounts']);
  if (!Array.isArray(input.accounts) || input.accounts.length > 1_024) {
    throw invalidProtocolFrame('Invalid Bedrock SSO accounts');
  }
  return {
    accounts: input.accounts.map((value) => {
      const account = requireShapedRecord(
        value,
        'Bedrock SSO account',
        ['accountId'],
        ['accountName', 'emailAddress'],
      );
      return {
        accountId: requireString(account.accountId, 'accountId', 12),
        ...(account.accountName === undefined
          ? {}
          : { accountName: requireString(account.accountName, 'accountName', 256) }),
        ...(account.emailAddress === undefined
          ? {}
          : { emailAddress: requireString(account.emailAddress, 'emailAddress', 320) }),
      };
    }),
  };
}

function decodeRolesInput(value: unknown) {
  const input = requireExactRecord(value, 'Bedrock SSO roles input', ['attemptId', 'accountId']);
  return {
    attemptId: requireEntityId(input.attemptId, 'attemptId'),
    accountId: requireString(input.accountId, 'accountId', 12),
  };
}

function decodeRoles(value: unknown) {
  const input = requireExactRecord(value, 'Bedrock SSO roles', ['roles']);
  if (!Array.isArray(input.roles) || input.roles.length > 1_024) {
    throw invalidProtocolFrame('Invalid Bedrock SSO roles');
  }
  return { roles: input.roles.map((role) => requireString(role, 'roleName', 64)) };
}

function decodeModelsInput(value: unknown) {
  const input = requireExactRecord(value, 'Bedrock model fetch input', [
    'attemptId',
    'accountId',
    'roleName',
    'manualModelIds',
  ]);
  if (!Array.isArray(input.manualModelIds) || input.manualModelIds.length > 64) {
    throw invalidProtocolFrame('Invalid manual Bedrock model ids');
  }
  return {
    attemptId: requireEntityId(input.attemptId, 'attemptId'),
    accountId: requireString(input.accountId, 'accountId', 12),
    roleName: requireString(input.roleName, 'roleName', 64),
    manualModelIds: input.manualModelIds.map(decodeConnectionModelId),
  };
}

function decodeModels(value: unknown) {
  assertBoundedProjection(value, 512 * 1024, 'Bedrock models');
  const input = requireExactRecord(value, 'Bedrock models', ['models']);
  if (!Array.isArray(input.models) || input.models.length > 2_048) {
    throw invalidProtocolFrame('Invalid Bedrock models');
  }
  return { models: input.models.map(decodeConnectionModel) };
}

function decodeCommitInput(value: unknown) {
  const input = requireExactRecord(value, 'Bedrock onboarding commit input', [
    'attemptId',
    'enabledModelIds',
  ]);
  if (!Array.isArray(input.enabledModelIds) || input.enabledModelIds.length > 512) {
    throw invalidProtocolFrame('Invalid enabled Bedrock model ids');
  }
  return {
    attemptId: requireEntityId(input.attemptId, 'attemptId'),
    enabledModelIds: input.enabledModelIds.map(decodeConnectionModelId),
  };
}

function assertBoundedProjection(value: unknown, maximum: number, label: string): void {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  if (bytes > maximum) throw invalidProtocolFrame(`${label} exceeds its byte limit`);
}

function decodeCommitOutput(value: unknown) {
  const input = requireExactRecord(value, 'Bedrock onboarding commit output', [
    'connectionId',
    'slug',
  ]);
  return {
    connectionId: requireEntityId(input.connectionId, 'connectionId'),
    slug: requireString(input.slug, 'slug', 128),
  };
}
