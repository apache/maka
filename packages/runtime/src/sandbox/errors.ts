import {
  validateSandboxBoundaryExpansion,
  type SandboxBoundaryExpansion,
} from '@maka/core/sandbox-boundary';

import type { SandboxType } from './types.js';

const SANDBOX_ERROR_DOMAINS = ['command', 'background_command', 'filesystem'] as const;
export type SandboxErrorDomain = (typeof SANDBOX_ERROR_DOMAINS)[number];
const SANDBOX_ERROR_STAGES = [
  'capability',
  'context',
  'selection',
  'validation',
  'transform',
  'launch',
  'protocol',
  'operation',
] as const;
export type SandboxErrorStage = (typeof SANDBOX_ERROR_STAGES)[number];

const SANDBOX_TYPES = ['none', 'macos-seatbelt', 'linux'] as const;
const STABLE_CODE_PATTERN = /^[a-z0-9_]+$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/;
const MAX_METADATA_VALUE_CHARS = 128;

export interface SandboxErrorMetadata {
  domain: SandboxErrorDomain;
  stage: SandboxErrorStage;
  reason: string;
  backend?: SandboxType;
  recoverable: boolean;
  profileName?: string;
  requestId?: string;
  requiredExpansion?: SandboxBoundaryExpansion;
}

export interface SandboxErrorWithMetadata extends Error, SandboxErrorMetadata {
  code: string;
}

export class SandboxCommandError extends Error implements SandboxErrorWithMetadata {
  readonly code = 'SANDBOX_COMMAND_EXECUTION_FAILED';
  readonly domain: SandboxErrorDomain;
  readonly stage: SandboxErrorStage;
  readonly reason: string;
  readonly backend?: SandboxType;
  readonly recoverable: boolean;
  readonly profileName?: string;
  readonly requestId?: string;
  readonly requiredExpansion?: SandboxBoundaryExpansion;

  constructor(input: SandboxErrorMetadata & { message?: string }) {
    super(input.message ?? `Command sandbox failed: ${input.reason}.`);
    this.name = 'SandboxCommandError';
    this.domain = input.domain;
    this.stage = input.stage;
    this.reason = input.reason;
    this.backend = input.backend;
    this.recoverable = input.recoverable;
    this.profileName = input.profileName;
    this.requestId = input.requestId;
    this.requiredExpansion = input.requiredExpansion;
  }
}

export function sandboxErrorMetadata(error: unknown): SandboxErrorMetadata | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as Partial<SandboxErrorWithMetadata>;
  if (
    !isMember(value.domain, SANDBOX_ERROR_DOMAINS) ||
    !isMember(value.stage, SANDBOX_ERROR_STAGES) ||
    !isBoundedMatch(value.reason, STABLE_CODE_PATTERN) ||
    typeof value.recoverable !== 'boolean' ||
    (value.backend !== undefined && !isMember(value.backend, SANDBOX_TYPES))
  ) {
    return undefined;
  }
  return {
    domain: value.domain,
    stage: value.stage,
    reason: value.reason,
    recoverable: value.recoverable,
    ...(value.backend ? { backend: value.backend } : {}),
    ...(isBoundedMatch(value.profileName, SAFE_IDENTIFIER_PATTERN)
      ? { profileName: value.profileName }
      : {}),
    ...(isBoundedMatch(value.requestId, SAFE_IDENTIFIER_PATTERN)
      ? { requestId: value.requestId }
      : {}),
    ...(isSandboxBoundaryExpansion(value.requiredExpansion)
      ? { requiredExpansion: value.requiredExpansion }
      : {}),
  };
}

export function serializeSandboxError(error: unknown): Record<string, unknown> | undefined {
  const metadata = sandboxErrorMetadata(error);
  return metadata ? { ...metadata } : undefined;
}

function isMember<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function isBoundedMatch(value: unknown, pattern: RegExp): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_METADATA_VALUE_CHARS &&
    pattern.test(value)
  );
}

function isSandboxBoundaryExpansion(value: unknown): value is SandboxBoundaryExpansion {
  if (value === undefined) return false;
  return validateSandboxBoundaryExpansion(value).ok;
}
