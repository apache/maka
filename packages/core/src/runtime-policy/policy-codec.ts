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

import { isThinkingLevel } from '../model-thinking.js';
import { CHAT_DEFAULT_PERMISSION_MODES } from '../settings.js';
import { normalizeSubagentSettings } from '../subagent-settings.js';
import type {
  AgentRuntimeSettingsPatch,
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

/** Upgrade the immediately previous canonical document with the new shell default. */
export function decodeRuntimePolicyV2(value: unknown): RuntimePolicy {
  const policy = exactRecord(value, 'runtime policy v2', [
    'networkProxy',
    'personalization',
    'memory',
    'workspaceInstructions',
    'privacy',
    'chatDefaults',
    'webSearch',
    'subagents',
  ]);
  const decoded = normalizeRuntimePolicyFields(
    policy,
    normalizeSubagentSettings(policy.subagents),
    { preference: 'auto', executable: '' },
  );
  assertCanonicalValue(value, withoutShell(decoded), 'runtime policy v2');
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
    'subagents',
    'shell',
  ]);
  return normalizeRuntimePolicyFields(
    policy,
    normalizeSubagentSettings(policy.subagents),
    normalizeShell(policy.shell),
  );
}

function normalizeRuntimePolicyFields(
  policy: Record<string, unknown>,
  subagents: RuntimePolicy['subagents'],
  shell: RuntimePolicy['shell'],
): RuntimePolicy {
  return {
    networkProxy: normalizeNetworkProxy(policy.networkProxy),
    personalization: normalizePersonalization(policy.personalization),
    memory: normalizeMemory(policy.memory),
    workspaceInstructions: normalizeWorkspaceInstructions(policy.workspaceInstructions),
    privacy: normalizePrivacy(policy.privacy),
    chatDefaults: normalizeChatDefaults(policy.chatDefaults),
    webSearch: normalizeWebSearch(policy.webSearch),
    subagents,
    shell,
  };
}

function withoutShell(policy: RuntimePolicy): Omit<RuntimePolicy, 'shell'> {
  const { shell: _shell, ...legacy } = policy;
  return legacy;
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
    case 'set_subagents':
      return { kind: operation.kind, value: normalizeSubagentSettings(operation.value) };
    case 'set_shell':
      return { kind: operation.kind, value: normalizeShell(operation.value) };
    case 'patch_agent_settings':
      return { kind: operation.kind, value: normalizeAgentRuntimeSettingsPatch(operation.value) };
    default:
      throw domainError(`runtime policy operation '${String(operation.kind)}' is unknown`);
  }
}

function normalizeShell(value: unknown): RuntimePolicy['shell'] {
  const item = exactRecord(value, 'shell policy', ['preference', 'executable']);
  if (item.preference !== 'auto' && item.preference !== 'git_bash') {
    throw domainError('shell preference is invalid');
  }
  const executable = stringValue(item.executable, 'shell executable', 4_096).trim();
  if (/[\u0000-\u001f\u007f-\u009f]/.test(executable)) {
    throw domainError('shell executable must not contain control characters');
  }
  if (item.preference === 'git_bash' && executable.length === 0) {
    throw domainError('Git Bash executable must not be empty');
  }
  return { preference: item.preference, executable };
}

function normalizeAgentRuntimeSettingsPatch(value: unknown): AgentRuntimeSettingsPatch {
  const patch = exactRecord(
    value,
    'agent runtime settings patch',
    ['personalization', 'memory', 'workspaceInstructions', 'privacy', 'webSearch'],
    [],
  );
  return {
    ...(patch.personalization === undefined
      ? {}
      : { personalization: normalizePersonalizationPatch(patch.personalization) }),
    ...(patch.memory === undefined ? {} : { memory: normalizeMemoryPatch(patch.memory) }),
    ...(patch.workspaceInstructions === undefined
      ? {}
      : {
          workspaceInstructions: normalizeEnabledPatch(
            patch.workspaceInstructions,
            'workspace instructions patch',
          ),
        }),
    ...(patch.privacy === undefined ? {} : { privacy: normalizePrivacyPatch(patch.privacy) }),
    ...(patch.webSearch === undefined
      ? {}
      : { webSearch: normalizeEnabledPatch(patch.webSearch, 'web search patch') }),
  };
}

function normalizePersonalizationPatch(
  value: unknown,
): AgentRuntimeSettingsPatch['personalization'] {
  const patch = exactRecord(value, 'personalization patch', ['displayName', 'assistantTone'], []);
  return {
    ...(patch.displayName === undefined
      ? {}
      : { displayName: stringValue(patch.displayName, 'personalization displayName', 256) }),
    ...(patch.assistantTone === undefined
      ? {}
      : {
          assistantTone: stringValue(patch.assistantTone, 'personalization assistantTone', 4_096),
        }),
  };
}

function normalizeMemoryPatch(value: unknown): AgentRuntimeSettingsPatch['memory'] {
  const patch = exactRecord(value, 'memory patch', ['enabled', 'agentReadEnabled'], []);
  return {
    ...(patch.enabled === undefined
      ? {}
      : { enabled: booleanValue(patch.enabled, 'memory enabled') }),
    ...(patch.agentReadEnabled === undefined
      ? {}
      : {
          agentReadEnabled: booleanValue(patch.agentReadEnabled, 'memory agentReadEnabled'),
        }),
  };
}

function normalizePrivacyPatch(value: unknown): AgentRuntimeSettingsPatch['privacy'] {
  const patch = exactRecord(value, 'privacy patch', ['incognitoActive'], []);
  return {
    ...(patch.incognitoActive === undefined
      ? {}
      : { incognitoActive: booleanValue(patch.incognitoActive, 'privacy incognitoActive') }),
  };
}

function normalizeEnabledPatch(value: unknown, name: string): { readonly enabled?: boolean } {
  const patch = exactRecord(value, name, ['enabled'], []);
  return {
    ...(patch.enabled === undefined
      ? {}
      : { enabled: booleanValue(patch.enabled, `${name} enabled`) }),
  };
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
  const item = exactRecord(
    value,
    'chat defaults',
    ['permissionMode', 'thinkingLevel'],
    ['permissionMode'],
  );
  if (!(CHAT_DEFAULT_PERMISSION_MODES as readonly unknown[]).includes(item.permissionMode)) {
    throw domainError('chat default permission mode is invalid');
  }
  if (item.thinkingLevel !== undefined && !isThinkingLevel(item.thinkingLevel)) {
    throw domainError('chat default thinking level is invalid');
  }
  return {
    permissionMode: item.permissionMode as RuntimePolicy['chatDefaults']['permissionMode'],
    ...(item.thinkingLevel === undefined ? {} : { thinkingLevel: item.thinkingLevel }),
  };
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
