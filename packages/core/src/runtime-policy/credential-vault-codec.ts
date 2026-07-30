import type {
  CredentialLocator,
  CredentialStatus,
  CredentialVersionBasis,
  DeleteCredentialInput,
  SetCredentialInput,
} from '../runtime-policy.js';
import { WEB_SEARCH_PROVIDERS } from '../web-search.js';
import {
  domainError,
  entityIdValue,
  exactRecord,
  integerValue,
  positiveRevisionValue,
} from './domain-codec.js';

export function decodeCredentialLocator(value: unknown): CredentialLocator {
  const base = exactRecord(
    value,
    'credential locator',
    ['scope', 'connectionId', 'provider', 'kind'],
    ['scope', 'kind'],
  );
  if (base.scope === 'connection') {
    const item = exactRecord(value, 'connection credential locator', [
      'scope',
      'connectionId',
      'kind',
    ]);
    if (item.kind !== 'api_key' && item.kind !== 'oauth_token') {
      throw domainError('connection credential kind is invalid');
    }
    return {
      scope: 'connection',
      connectionId: entityIdValue(item.connectionId, 'connection id'),
      kind: item.kind,
    };
  }
  if (base.scope === 'web_search') {
    const item = exactRecord(value, 'web search credential locator', ['scope', 'provider', 'kind']);
    if (
      item.kind !== 'api_key' ||
      !(WEB_SEARCH_PROVIDERS as readonly unknown[]).includes(item.provider)
    ) {
      throw domainError('web search credential locator is invalid');
    }
    return {
      scope: 'web_search',
      provider: item.provider as Extract<CredentialLocator, { scope: 'web_search' }>['provider'],
      kind: 'api_key',
    };
  }
  if (base.scope === 'network_proxy') {
    const item = exactRecord(value, 'network proxy credential locator', ['scope', 'kind']);
    if (item.kind !== 'password') throw domainError('network proxy credential kind is invalid');
    return { scope: 'network_proxy', kind: 'password' };
  }
  throw domainError('credential locator scope is invalid');
}

export function decodeCredentialVersionBasis(value: unknown): CredentialVersionBasis {
  const item = exactRecord(value, 'credential basis', ['locator', 'credentialId', 'revision']);
  return {
    locator: decodeCredentialLocator(item.locator),
    credentialId: entityIdValue(item.credentialId, 'credential id'),
    revision: positiveRevisionValue(item.revision, 'credential revision'),
  };
}

export function decodeCredentialStatus(value: unknown): CredentialStatus {
  const item = exactRecord(value, 'credential status', [
    'locator',
    'configured',
    'credentialId',
    'revision',
    'updatedAt',
  ]);
  if (item.configured === false) {
    if (item.credentialId !== null || item.revision !== null || item.updatedAt !== null) {
      throw domainError('unconfigured credential status must not carry version metadata');
    }
    return {
      locator: decodeCredentialLocator(item.locator),
      configured: false,
      credentialId: null,
      revision: null,
      updatedAt: null,
    };
  }
  if (item.configured === true) {
    return {
      locator: decodeCredentialLocator(item.locator),
      configured: true,
      credentialId: entityIdValue(item.credentialId, 'credential id'),
      revision: positiveRevisionValue(item.revision, 'credential revision'),
      updatedAt: integerValue(item.updatedAt, 'credential updatedAt', 0, Number.MAX_SAFE_INTEGER),
    };
  }
  throw domainError('credential status configured flag is invalid');
}

export function normalizeSetCredentialInput(value: unknown): SetCredentialInput {
  const input = exactRecord(value, 'set credential input', ['locator', 'expected', 'secret']);
  let expected: SetCredentialInput['expected'];
  if (input.expected === null) {
    expected = null;
  } else {
    const basis = exactRecord(input.expected, 'set credential expected basis', [
      'credentialId',
      'revision',
    ]);
    expected = {
      credentialId: entityIdValue(basis.credentialId, 'credential id'),
      revision: positiveRevisionValue(basis.revision, 'credential revision'),
    };
  }
  return {
    locator: decodeCredentialLocator(input.locator),
    expected,
    secret: normalizeCredentialSecret(input.secret),
  };
}

export function normalizeDeleteCredentialInput(value: unknown): DeleteCredentialInput {
  const input = exactRecord(value, 'delete credential input', ['expected']);
  return { expected: decodeCredentialVersionBasis(input.expected) };
}

export function normalizeCredentialSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw domainError('credential secret must be a non-empty string');
  }
  return value;
}
