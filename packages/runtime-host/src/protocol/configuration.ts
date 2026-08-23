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
  REQUEST_HEADERS_MAX_BYTES,
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
}

export interface ConfigurationCredentialExportResult {
  readonly credential: {
    readonly locator: CredentialLocator;
    readonly secretBase64: string;
  } | null;
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
  const input = requireExactRecord(value, 'configuration credential export input', ['locator']);
  return { locator: decodeLocator(input.locator) };
}

function decodeConfigurationCredentialExportResult(
  value: unknown,
): ConfigurationCredentialExportResult {
  const result = requireExactRecord(value, 'configuration credential export result', [
    'credential',
  ]);
  if (result.credential === null) return { credential: null };
  const entry = requireShapedRecord(
    result.credential,
    'exported configuration credential',
    ['locator', 'secretBase64'],
    [],
  );
  const locator = decodeLocator(entry.locator);
  const maxBytes =
    locator.scope === 'connection' && locator.kind === 'request_headers'
      ? REQUEST_HEADERS_MAX_BYTES
      : CREDENTIAL_SECRET_MAX_BYTES;
  const decoded = {
    credential: {
      locator,
      secretBase64: decodeCredentialSecretBase64(entry.secretBase64, maxBytes),
    },
  };
  requireEncodedByteLimit(decoded, 'configuration credential export result', RESULT_MAX_BYTES);
  return decoded;
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
