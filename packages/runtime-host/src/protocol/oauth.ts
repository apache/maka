/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import {
  requireEntityId,
  requireExactRecord,
  requireRecord,
  requireShapedRecord,
  requireString,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const OAUTH_PRESENTATION_SERVICE_ID = 'oauth_presentation';
export const OAUTH_PRESENTATION_SERVICE_VERSION = '1';
export const OAUTH_PRESENTATION_URL_MAX_LENGTH = 8_192;
export const OAUTH_PRESENTATION_STATE_HINT_MAX_LENGTH = 1_024;
export const OAUTH_LOGIN_PROVIDERS = ['openai-codex', 'xai-oauth'] as const;
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

export type OAuthLoginProvider = (typeof OAUTH_LOGIN_PROVIDERS)[number];
export type OAuthLoginPhase = (typeof OAUTH_LOGIN_PHASES)[number];
export type OAuthLoginFailureCode = (typeof OAUTH_LOGIN_FAILURE_CODES)[number];
// One member today: every live enrolment is a device flow that opens a browser.
// The method still travels on the wire and is still validated on arrival, so a
// peer that offers anything else is refused rather than silently presented.
export type OAuthPresentationMethod = 'open_external';

export type OAuthPresentationRequest = {
  readonly method: 'open_external';
  readonly url: string;
  readonly stateHint?: string;
};

export type OAuthPresentationResult = { readonly kind: 'presented' };

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
  throw invalidProtocolFrame('Invalid OAuth presentation method');
}

export function decodeOAuthPresentationResult(
  method: OAuthPresentationMethod,
  value: unknown,
): OAuthPresentationResult {
  if (method !== 'open_external') {
    throw invalidProtocolFrame('Invalid OAuth presentation method');
  }
  const result = requireExactRecord(value, 'OAuth presentation result', ['kind']);
  if (result.kind !== 'presented') {
    throw invalidProtocolFrame('Invalid OAuth presentation result');
  }
  return { kind: result.kind };
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
