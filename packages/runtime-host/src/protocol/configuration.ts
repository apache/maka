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
  decodeCredentialLocator,
  decodeConnectionCredentialTarget,
  decodeConnectionVersionBasis,
  normalizeNetworkProxyCredentialTarget,
  REQUEST_HEADERS_MAX_BYTES,
  type ConnectionCredentialTarget,
  type ConnectionVersionBasis,
  type NetworkProxyCredentialTarget,
  type CredentialLocator,
} from '@maka/core/runtime-policy';
import {
  requireEncodedByteLimit,
  requireExactRecord,
  requireShapedRecord,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';
import { CREDENTIAL_SECRET_MAX_BYTES } from './runtime-policy.js';

const RESULT_MAX_BYTES = 90 * 1024;
const ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'internal_failure',
] as const;

export interface ConfigurationCredentialExportInput {
  readonly locator: CredentialLocator;
  readonly expectedConnection?: ConnectionCredentialTarget;
}

export interface ConfigurationCredentialExportResult {
  readonly credential: {
    readonly locator: CredentialLocator;
    readonly secretBase64: string;
    readonly proxyTarget?: NetworkProxyCredentialTarget;
  } | null;
  readonly connectionStale?: {
    readonly expected: ConnectionVersionBasis;
    readonly actual: ConnectionVersionBasis | null;
  };
}

export const CONFIGURATION_OPERATION_SPECS = {
  'configuration.credentials.export': defineOperation<
    ConfigurationCredentialExportInput,
    ConfigurationCredentialExportResult,
    (typeof ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: ERRORS,
    decodeInput: decodeConfigurationCredentialExportInput,
    decodeOutput: decodeConfigurationCredentialExportResult,
  }),
} as const;

function decodeConfigurationCredentialExportInput(
  value: unknown,
): ConfigurationCredentialExportInput {
  const input = requireShapedRecord(
    value,
    'configuration credential export input',
    ['locator'],
    ['expectedConnection'],
  );
  const locator = decodeLocator(input.locator);
  const expectedConnection =
    input.expectedConnection === undefined
      ? undefined
      : decodeDomainValue(() => decodeConnectionCredentialTarget(input.expectedConnection));
  if (expectedConnection && locator.scope !== 'connection') {
    throw invalidProtocolFrame('Only connection credential exports accept a target basis');
  }
  return {
    locator,
    ...(expectedConnection === undefined ? {} : { expectedConnection }),
  };
}

function decodeConfigurationCredentialExportResult(
  value: unknown,
): ConfigurationCredentialExportResult {
  const result = requireShapedRecord(
    value,
    'configuration credential export result',
    ['credential'],
    ['connectionStale'],
  );
  const connectionStale =
    result.connectionStale === undefined
      ? undefined
      : decodeConnectionStale(result.connectionStale);
  if (connectionStale && result.credential !== null) {
    throw invalidProtocolFrame('A stale connection export must not include credential material');
  }
  if (result.credential === null) {
    return {
      credential: null,
      ...(connectionStale === undefined ? {} : { connectionStale }),
    };
  }
  const entry = requireShapedRecord(
    result.credential,
    'exported configuration credential',
    ['locator', 'secretBase64'],
    ['proxyTarget'],
  );
  const locator = decodeLocator(entry.locator);
  const proxyTarget =
    entry.proxyTarget === undefined
      ? undefined
      : decodeDomainValue(() => normalizeNetworkProxyCredentialTarget(entry.proxyTarget));
  if (proxyTarget && locator.scope !== 'network_proxy') {
    throw invalidProtocolFrame('Only proxy credentials may carry a proxy target');
  }
  const maxBytes =
    locator.scope === 'connection' && locator.kind === 'request_headers'
      ? REQUEST_HEADERS_MAX_BYTES
      : CREDENTIAL_SECRET_MAX_BYTES;
  const decoded = {
    credential: {
      locator,
      secretBase64: decodeCredentialSecretBase64(entry.secretBase64, maxBytes),
      ...(proxyTarget === undefined ? {} : { proxyTarget }),
    },
    ...(connectionStale === undefined ? {} : { connectionStale }),
  };
  requireEncodedByteLimit(decoded, 'configuration credential export result', RESULT_MAX_BYTES);
  return decoded;
}

function decodeConnectionStale(value: unknown): {
  expected: ConnectionVersionBasis;
  actual: ConnectionVersionBasis | null;
} {
  const stale = requireExactRecord(value, 'configuration credential stale connection', [
    'expected',
    'actual',
  ]);
  return {
    expected: decodeDomainValue(() => decodeConnectionVersionBasis(stale.expected)),
    actual:
      stale.actual === null
        ? null
        : decodeDomainValue(() => decodeConnectionVersionBasis(stale.actual)),
  };
}

function decodeDomainValue<T>(decode: () => T): T {
  try {
    return decode();
  } catch {
    throw invalidProtocolFrame('Invalid configuration credential connection basis');
  }
}

function decodeCredentialSecretBase64(value: unknown, maxBytes: number): string {
  const encoded = requireUtf8String(
    value,
    'exported configuration credential secret',
    Math.ceil(maxBytes / 3) * 4,
  );
  const decoded = Buffer.from(encoded, 'base64');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(decoded);
  } catch {
    throw invalidProtocolFrame('Invalid exported configuration credential secret');
  }
  if (decoded.byteLength > maxBytes || decoded.toString('base64') !== encoded) {
    throw invalidProtocolFrame('Invalid exported configuration credential secret');
  }
  return encoded;
}

function decodeLocator(value: unknown): CredentialLocator {
  try {
    return decodeCredentialLocator(value);
  } catch {
    throw invalidProtocolFrame('Invalid configuration credential locator');
  }
}
