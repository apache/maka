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
  requireShapedRecord,
  requireString,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

// Official ACP Registry, pinned to the distribution verified for this integration.
export const ANTIGRAVITY_ACP_RELEASE = {
  version: '1.1.1',
  url: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_1.1.1-darwin-arm64.zip',
  archiveBytes: 316_014_828,
  sha256: 'fdfa915652cdb7ba8085cc8fffed072cbe009251aa2c951aabdda07a8c28a189',
} as const;

export type ExternalAgentSetupAction = 'check' | 'login' | 'install';
export type ExternalAgentSetupPhase =
  | 'downloading'
  | 'installing'
  | 'connecting'
  | 'awaiting_authorization'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
export const EXTERNAL_AGENT_SETUP_FAILURES = [
  'download_failed',
  'integrity_failed',
  'installation_failed',
  'executable_unavailable',
  'helper_unavailable',
  'connection_failed',
  'authentication_unavailable',
  'authentication_failed',
  'account_ineligible',
  'browser_failed',
  'timed_out',
  'cleanup_failed',
] as const;
export type ExternalAgentSetupFailure = (typeof EXTERNAL_AGENT_SETUP_FAILURES)[number];
export interface ExternalAgentSetupStart {
  readonly attemptId: string;
  readonly action: ExternalAgentSetupAction;
  /** Comparison only: the Host launches the path read from RuntimePolicy. */
  readonly expectedExecutable: string;
}
export interface ExternalAgentSetupAttempt {
  readonly attemptId: string;
}
export interface ExternalAgentSetupProjection extends ExternalAgentSetupStart {
  readonly phase: ExternalAgentSetupPhase;
  readonly failure?: ExternalAgentSetupFailure;
  readonly installedExecutable?: string;
  readonly downloadPercent?: number;
}
const errors = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'internal_failure',
  'operation_conflict',
  'not_found',
] as const;
const common = {
  availability: 'ready' as const,
  errors,
  decodeOutput: decodeExternalAgentSetupProjection,
  assertOutputForInput(input: ExternalAgentSetupAttempt, output: ExternalAgentSetupProjection) {
    if (input.attemptId !== output.attemptId)
      throw invalidProtocolFrame('Setup attempt changed identity');
  },
};
export const EXTERNAL_AGENT_SETUP_OPERATION_SPECS = {
  'external_agents.setup.start': defineOperation<
    ExternalAgentSetupStart,
    ExternalAgentSetupProjection,
    (typeof errors)[number]
  >({
    ...common,
    mode: 'command',
    decodeInput: decodeExternalAgentSetupStart,
    assertOutputForInput(input, output) {
      common.assertOutputForInput(input, output);
      if (input.action !== output.action || input.expectedExecutable !== output.expectedExecutable)
        throw invalidProtocolFrame('Setup changed configuration');
    },
  }),
  'external_agents.setup.query': defineOperation<
    ExternalAgentSetupAttempt,
    ExternalAgentSetupProjection,
    (typeof errors)[number]
  >({
    ...common,
    mode: 'query',
    decodeInput: decodeExternalAgentSetupAttempt,
  }),
  'external_agents.setup.cancel': defineOperation<
    ExternalAgentSetupAttempt,
    ExternalAgentSetupProjection,
    (typeof errors)[number]
  >({
    ...common,
    mode: 'control',
    decodeInput: decodeExternalAgentSetupAttempt,
  }),
} as const;
export function decodeExternalAgentSetupStart(value: unknown): ExternalAgentSetupStart {
  const item = requireExactRecord(value, 'external agent setup', [
    'attemptId',
    'action',
    'expectedExecutable',
  ]);
  return startFields(item);
}
function startFields(item: Record<string, unknown>): ExternalAgentSetupStart {
  if (item.action !== 'check' && item.action !== 'login' && item.action !== 'install')
    throw invalidProtocolFrame('Invalid setup action');
  return {
    attemptId: requireEntityId(item.attemptId, 'attemptId'),
    action: item.action,
    expectedExecutable:
      item.action === 'install' && item.expectedExecutable === ''
        ? ''
        : requireString(item.expectedExecutable, 'expectedExecutable', 4096),
  };
}
export function decodeExternalAgentSetupAttempt(value: unknown): ExternalAgentSetupAttempt {
  const item = requireExactRecord(value, 'setup attempt', ['attemptId']);
  return { attemptId: requireEntityId(item.attemptId, 'attemptId') };
}
export function decodeExternalAgentSetupProjection(value: unknown): ExternalAgentSetupProjection {
  const item = requireShapedRecord(
    value,
    'setup projection',
    ['attemptId', 'action', 'expectedExecutable', 'phase'],
    ['failure', 'installedExecutable', 'downloadPercent'],
  );
  if (
    ![
      'downloading',
      'installing',
      'connecting',
      'awaiting_authorization',
      'cancelling',
      'succeeded',
      'failed',
      'cancelled',
    ].includes(item.phase as string)
  )
    throw invalidProtocolFrame('Invalid setup phase');
  if (
    item.phase === 'failed'
      ? !EXTERNAL_AGENT_SETUP_FAILURES.includes(item.failure as ExternalAgentSetupFailure)
      : item.failure !== undefined
  )
    throw invalidProtocolFrame('Invalid setup failure');
  if ((item.phase === 'downloading' || item.phase === 'installing') && item.action !== 'install')
    throw invalidProtocolFrame('Invalid installation phase');
  if (
    item.downloadPercent !== undefined &&
    (item.action !== 'install' ||
      !Number.isInteger(item.downloadPercent) ||
      (item.downloadPercent as number) < 0 ||
      (item.downloadPercent as number) > 100)
  )
    throw invalidProtocolFrame('Invalid download progress');
  if (item.action === 'install' && item.phase === 'succeeded') {
    const path = requireString(item.installedExecutable, 'installedExecutable', 4096);
    if (!path.startsWith('/') || /[\x00-\x1f]/u.test(path))
      throw invalidProtocolFrame('Invalid installed path');
  } else if (item.installedExecutable !== undefined)
    throw invalidProtocolFrame('Unexpected installed path');
  return {
    ...startFields(item),
    ...(item.installedExecutable !== undefined
      ? { installedExecutable: item.installedExecutable as string }
      : {}),
    ...(item.downloadPercent !== undefined
      ? { downloadPercent: item.downloadPercent as number }
      : {}),
    phase: item.phase as ExternalAgentSetupPhase,
    ...(item.phase === 'failed' ? { failure: item.failure as ExternalAgentSetupFailure } : {}),
  };
}
