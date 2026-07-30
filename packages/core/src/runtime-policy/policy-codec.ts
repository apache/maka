import { CHAT_DEFAULT_PERMISSION_MODES } from '../settings.js';
import type {
  MutateRuntimePolicyInput,
  RuntimePolicy,
  RuntimePolicyMutation,
} from '../runtime-policy.js';
import { WEB_SEARCH_PROVIDERS } from '../web-search.js';
import {
  assertCanonicalValue,
  booleanValue,
  domainError,
  exactRecord,
  integerValue,
  revisionValue,
  stringArrayValue,
  stringValue,
} from './domain-codec.js';

export function decodeCanonicalRuntimePolicy(value: unknown): RuntimePolicy {
  const decoded = normalizeRuntimePolicy(value);
  assertCanonicalValue(value, decoded, 'runtime policy');
  return decoded;
}

export function normalizeRuntimePolicyMutation(value: unknown): MutateRuntimePolicyInput {
  const input = exactRecord(value, 'runtime policy mutation', ['expectedRevision', 'operation']);
  const operation = exactRecord(input.operation, 'runtime policy operation', ['kind', 'value']);
  return {
    expectedRevision: revisionValue(input.expectedRevision, 'runtime policy expected revision'),
    operation: normalizeMutationOperation(operation),
  };
}

function normalizeRuntimePolicy(value: unknown): RuntimePolicy {
  const policy = exactRecord(value, 'runtime policy', [
    'networkProxy',
    'personalization',
    'memory',
    'workspaceInstructions',
    'privacy',
    'chatDefaults',
    'webSearch',
  ]);
  return {
    networkProxy: normalizeNetworkProxy(policy.networkProxy),
    personalization: normalizePersonalization(policy.personalization),
    memory: normalizeMemory(policy.memory),
    workspaceInstructions: normalizeWorkspaceInstructions(policy.workspaceInstructions),
    privacy: normalizePrivacy(policy.privacy),
    chatDefaults: normalizeChatDefaults(policy.chatDefaults),
    webSearch: normalizeWebSearch(policy.webSearch),
  };
}

function normalizeMutationOperation(operation: Record<string, unknown>): RuntimePolicyMutation {
  switch (operation.kind) {
    case 'set_network_proxy':
      return { kind: operation.kind, value: normalizeNetworkProxy(operation.value) };
    case 'set_personalization':
      return { kind: operation.kind, value: normalizePersonalization(operation.value) };
    case 'set_memory':
      return { kind: operation.kind, value: normalizeMemory(operation.value) };
    case 'set_workspace_instructions':
      return { kind: operation.kind, value: normalizeWorkspaceInstructions(operation.value) };
    case 'set_privacy':
      return { kind: operation.kind, value: normalizePrivacy(operation.value) };
    case 'set_chat_defaults':
      return { kind: operation.kind, value: normalizeChatDefaults(operation.value) };
    case 'set_web_search':
      return { kind: operation.kind, value: normalizeWebSearch(operation.value) };
    default:
      throw domainError(`runtime policy operation '${String(operation.kind)}' is unknown`);
  }
}

function normalizeNetworkProxy(value: unknown): RuntimePolicy['networkProxy'] {
  const item = exactRecord(value, 'network proxy', [
    'enabled',
    'protocol',
    'host',
    'port',
    'authEnabled',
    'username',
    'bypassList',
    'autoBypassDomains',
  ]);
  const enabled = booleanValue(item.enabled, 'network proxy enabled');
  const rawHost = stringValue(item.host, 'network proxy host', 255);
  if (/[\u0000-\u001f\u007f-\u009f]/.test(rawHost)) {
    throw domainError('network proxy host must not contain control characters');
  }
  const host = rawHost.trim();
  if (enabled && host.length === 0) {
    throw domainError('network proxy host must not be empty when enabled');
  }
  if (item.protocol !== 'http' && item.protocol !== 'https' && item.protocol !== 'socks5') {
    throw domainError('network proxy protocol is invalid');
  }
  return {
    enabled,
    protocol: item.protocol,
    host,
    port: integerValue(item.port, 'network proxy port', 1, 65_535),
    authEnabled: booleanValue(item.authEnabled, 'network proxy authEnabled'),
    username: stringValue(item.username, 'network proxy username', 256),
    bypassList: stringArrayValue(item.bypassList, 'network proxy bypassList', 256),
    autoBypassDomains: stringArrayValue(
      item.autoBypassDomains,
      'network proxy autoBypassDomains',
      256,
    ),
  };
}

function normalizePersonalization(value: unknown): RuntimePolicy['personalization'] {
  const item = exactRecord(value, 'personalization', ['displayName', 'assistantTone']);
  return {
    displayName: stringValue(item.displayName, 'personalization displayName', 256),
    assistantTone: stringValue(item.assistantTone, 'personalization assistantTone', 4_096),
  };
}

function normalizeMemory(value: unknown): RuntimePolicy['memory'] {
  const item = exactRecord(value, 'memory policy', ['enabled', 'agentReadEnabled']);
  return {
    enabled: booleanValue(item.enabled, 'memory enabled'),
    agentReadEnabled: booleanValue(item.agentReadEnabled, 'memory agentReadEnabled'),
  };
}

function normalizeWorkspaceInstructions(value: unknown): RuntimePolicy['workspaceInstructions'] {
  const item = exactRecord(value, 'workspace instructions policy', ['enabled']);
  return { enabled: booleanValue(item.enabled, 'workspace instructions enabled') };
}

function normalizePrivacy(value: unknown): RuntimePolicy['privacy'] {
  const item = exactRecord(value, 'privacy policy', ['incognitoActive']);
  return { incognitoActive: booleanValue(item.incognitoActive, 'privacy incognitoActive') };
}

function normalizeChatDefaults(value: unknown): RuntimePolicy['chatDefaults'] {
  const item = exactRecord(value, 'chat defaults', ['permissionMode']);
  if (!(CHAT_DEFAULT_PERMISSION_MODES as readonly unknown[]).includes(item.permissionMode)) {
    throw domainError('chat default permission mode is invalid');
  }
  return { permissionMode: item.permissionMode as RuntimePolicy['chatDefaults']['permissionMode'] };
}

function normalizeWebSearch(value: unknown): RuntimePolicy['webSearch'] {
  const item = exactRecord(value, 'web search policy', ['enabled', 'defaultProvider']);
  if (!(WEB_SEARCH_PROVIDERS as readonly unknown[]).includes(item.defaultProvider)) {
    throw domainError('web search default provider is invalid');
  }
  return {
    enabled: booleanValue(item.enabled, 'web search enabled'),
    defaultProvider: item.defaultProvider as RuntimePolicy['webSearch']['defaultProvider'],
  };
}
