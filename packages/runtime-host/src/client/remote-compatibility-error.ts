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
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type HostIncompatible,
} from '../protocol/index.js';
import { RuntimeHostPermanentReconnectError } from './reconnect-lifecycle.js';

export const RUNTIME_HOST_REMOTE_INCOMPATIBLE_CODE = 'RUNTIME_HOST_REMOTE_INCOMPATIBLE' as const;

export interface RuntimeHostRemoteCompatibilityDetails {
  readonly profileId: string;
  readonly client: {
    readonly compatibilityEpoch: number;
    readonly protocolMin: number;
    readonly protocolMax: number;
    readonly compositionId: string;
  };
  readonly host: {
    readonly compatibilityEpoch: number;
    readonly protocolMin: number;
    readonly protocolMax: number;
    readonly compositionId: string;
    readonly compositionRevision: string;
  };
}

export class RuntimeHostRemoteCompatibilityError extends RuntimeHostPermanentReconnectError {
  readonly name = 'RuntimeHostRemoteCompatibilityError';
  readonly code = RUNTIME_HOST_REMOTE_INCOMPATIBLE_CODE;
  readonly details: RuntimeHostRemoteCompatibilityDetails;

  constructor(profileId: string, handshake: HostIncompatible) {
    const details = Object.freeze({
      profileId,
      client: Object.freeze({
        compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
        protocolMin: RUNTIME_HOST_PROTOCOL_VERSION,
        protocolMax: RUNTIME_HOST_PROTOCOL_VERSION,
        compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
      }),
      host: Object.freeze({
        compatibilityEpoch: handshake.compatibilityEpoch,
        protocolMin: handshake.protocolMin,
        protocolMax: handshake.protocolMax,
        compositionId: handshake.compositionId,
        compositionRevision: handshake.compositionRevision,
      }),
    });
    super(formatRuntimeHostRemoteCompatibilityMessage(details));
    this.details = details;
  }
}

function formatRuntimeHostRemoteCompatibilityMessage(
  details: RuntimeHostRemoteCompatibilityDetails,
): string {
  const message = [
    `${RUNTIME_HOST_REMOTE_INCOMPATIBLE_CODE}: Runtime Host profile ${details.profileId} is incompatible`,
    `Client compatibility epoch ${details.client.compatibilityEpoch}`,
    `Host compatibility epoch ${details.host.compatibilityEpoch}`,
  ];
  if (!protocolRangesOverlap(details.client, details.host)) {
    message.push(
      `Client protocol range ${details.client.protocolMin}-${details.client.protocolMax}`,
      `Host protocol range ${details.host.protocolMin}-${details.host.protocolMax}`,
    );
  }
  if (details.client.compositionId !== details.host.compositionId) {
    message.push(
      `Client composition id ${details.client.compositionId}`,
      `Host composition id ${formatRuntimeHostDiagnosticValue(details.host.compositionId)}`,
      `Host composition revision ${formatRuntimeHostDiagnosticValue(details.host.compositionRevision)}`,
    );
  }
  message.push(
    'Use compatible Client and Host builds, restart the remote Runtime Host service after updating the Host, then retry',
  );
  return message.join('. ');
}

function formatRuntimeHostDiagnosticValue(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '\uFFFD');
}

function protocolRangesOverlap(
  client: RuntimeHostRemoteCompatibilityDetails['client'],
  host: RuntimeHostRemoteCompatibilityDetails['host'],
): boolean {
  return client.protocolMin <= host.protocolMax && host.protocolMin <= client.protocolMax;
}
