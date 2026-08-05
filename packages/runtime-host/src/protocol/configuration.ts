import { decodeCredentialLocator, type CredentialLocator } from '@maka/core/runtime-policy';
import {
  requireEncodedByteLimit,
  requireExactRecord,
  requireShapedRecord,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

const CREDENTIAL_MAX_COUNT = 128;
const SECRET_MAX_BYTES = 16 * 1024;
const RESULT_MAX_BYTES = 1024 * 1024;
const ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'internal_failure',
] as const;

export interface ConfigurationCredentialExportInput {
  readonly locators: readonly CredentialLocator[];
}

export interface ConfigurationCredentialExportResult {
  readonly credentials: readonly {
    readonly locator: CredentialLocator;
    readonly secret: string;
  }[];
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
  const input = requireExactRecord(value, 'configuration credential export input', ['locators']);
  if (!Array.isArray(input.locators) || input.locators.length > CREDENTIAL_MAX_COUNT) {
    throw invalidProtocolFrame('Invalid configuration credential locators');
  }
  return { locators: input.locators.map(decodeLocator) };
}

function decodeConfigurationCredentialExportResult(
  value: unknown,
): ConfigurationCredentialExportResult {
  const result = requireExactRecord(value, 'configuration credential export result', [
    'credentials',
  ]);
  if (!Array.isArray(result.credentials) || result.credentials.length > CREDENTIAL_MAX_COUNT) {
    throw invalidProtocolFrame('Invalid exported configuration credentials');
  }
  const credentials = result.credentials.map((value) => {
    const entry = requireShapedRecord(
      value,
      'exported configuration credential',
      ['locator', 'secret'],
      [],
    );
    return {
      locator: decodeLocator(entry.locator),
      secret: requireUtf8String(
        entry.secret,
        'exported configuration credential secret',
        SECRET_MAX_BYTES,
      ),
    };
  });
  const decoded = { credentials };
  requireEncodedByteLimit(decoded, 'configuration credential export result', RESULT_MAX_BYTES);
  return decoded;
}

function decodeLocator(value: unknown): CredentialLocator {
  try {
    return decodeCredentialLocator(value);
  } catch {
    throw invalidProtocolFrame('Invalid configuration credential locator');
  }
}
