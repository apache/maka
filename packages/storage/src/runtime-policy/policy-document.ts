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
  createDefaultRuntimePolicy,
  decodeCanonicalRuntimePolicy,
  decodeRuntimePolicyV2,
  normalizeRuntimePolicyMutation,
  type MutateRuntimePolicyInput,
  type MutateRuntimePolicyResult,
  type RuntimePolicy,
  type RuntimePolicyMutation,
  type RuntimePolicySnapshot,
} from '@maka/core/runtime-policy';
import { deepFreeze, nextRevision, record, revision } from './codec.js';
import {
  codecError,
  decodePersistedDomain,
  decodePolicyInput,
  RuntimePolicyStoreError,
} from './errors.js';
import {
  POLICY_DOCUMENT_MAX_BYTES,
  readBoundedJsonDocument,
  serializeJsonDocument,
  writeJsonDocument,
} from './document-io.js';

const FILE = 'runtime-policy.json';
const SCHEMA_VERSION = 3 as const;

export interface RuntimePolicyDocument {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly revision: number;
  readonly policy: RuntimePolicy;
}

export interface PreparedRuntimePolicyMutation {
  readonly kind: 'ready';
  readonly current: RuntimePolicyDocument;
  readonly next: RuntimePolicyDocument;
}

export class RuntimePolicyDocumentOwner {
  async read(root: string): Promise<RuntimePolicyDocument> {
    const value = await readBoundedJsonDocument(root, FILE, POLICY_DOCUMENT_MAX_BYTES);
    if (value === undefined) {
      return { schemaVersion: SCHEMA_VERSION, revision: 0, policy: createDefaultRuntimePolicy() };
    }
    const document = record(value, FILE, 'invalid_document', [
      'schemaVersion',
      'revision',
      'policy',
    ]);
    if (document.schemaVersion !== 2 && document.schemaVersion !== SCHEMA_VERSION) {
      throw codecError('invalid_document', `${FILE} has an unsupported schema version`);
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      revision: revision(document.revision, `${FILE}.revision`, 'invalid_document'),
      policy: decodePersistedDomain(() =>
        document.schemaVersion === 2
          ? decodeRuntimePolicyV2(document.policy)
          : decodeCanonicalRuntimePolicy(document.policy),
      ),
    };
  }

  async mutate(
    root: string,
    rawInput: MutateRuntimePolicyInput,
  ): Promise<MutateRuntimePolicyResult> {
    const current = await this.read(root);
    const prepared = this.prepareMutation(current, rawInput);
    if (prepared.kind !== 'ready') return prepared;
    return this.commitMutation(root, prepared);
  }

  prepareMutation(
    current: RuntimePolicyDocument,
    rawInput: MutateRuntimePolicyInput,
  ):
    | PreparedRuntimePolicyMutation
    | Exclude<MutateRuntimePolicyResult, { readonly kind: 'committed' }> {
    const input = decodePolicyInput(() => normalizeRuntimePolicyMutation(rawInput));
    if (current.revision !== input.expectedRevision) {
      return deepFreeze({
        kind: 'revision_conflict',
        expectedRevision: input.expectedRevision,
        actualRevision: current.revision,
      });
    }
    const next = {
      schemaVersion: SCHEMA_VERSION,
      revision: nextRevision(current.revision),
      policy: applyMutation(current.policy, input.operation),
    };
    if (serializeJsonDocument(next).length > POLICY_DOCUMENT_MAX_BYTES) {
      throw new RuntimePolicyStoreError(
        'invalid_policy_input',
        `runtime policy exceeds its ${POLICY_DOCUMENT_MAX_BYTES} byte limit`,
      );
    }
    return { kind: 'ready', current, next };
  }

  async commitMutation(
    root: string,
    prepared: PreparedRuntimePolicyMutation,
  ): Promise<Extract<MutateRuntimePolicyResult, { readonly kind: 'committed' }>> {
    await writeJsonDocument(root, FILE, prepared.next, POLICY_DOCUMENT_MAX_BYTES);
    return deepFreeze({ kind: 'committed', snapshot: policySnapshot(prepared.next) });
  }
}

export function policySnapshot(document: RuntimePolicyDocument): RuntimePolicySnapshot {
  return deepFreeze({ revision: document.revision, policy: structuredClone(document.policy) });
}

function applyMutation(policy: RuntimePolicy, operation: RuntimePolicyMutation): RuntimePolicy {
  switch (operation.kind) {
    case 'set_network_proxy':
      return { ...policy, networkProxy: operation.value };
    case 'set_personalization':
      return { ...policy, personalization: operation.value };
    case 'set_memory':
      return { ...policy, memory: operation.value };
    case 'set_workspace_instructions':
      return { ...policy, workspaceInstructions: operation.value };
    case 'set_privacy':
      return { ...policy, privacy: operation.value };
    case 'set_chat_defaults':
      return { ...policy, chatDefaults: operation.value };
    case 'set_web_search':
      return { ...policy, webSearch: operation.value };
    case 'set_subagents':
      return { ...policy, subagents: operation.value };
    case 'set_shell':
      return { ...policy, shell: operation.value };
    case 'patch_agent_settings':
      return {
        ...policy,
        ...(operation.value.personalization
          ? { personalization: { ...policy.personalization, ...operation.value.personalization } }
          : {}),
        ...(operation.value.memory
          ? { memory: { ...policy.memory, ...operation.value.memory } }
          : {}),
        ...(operation.value.workspaceInstructions
          ? {
              workspaceInstructions: {
                ...policy.workspaceInstructions,
                ...operation.value.workspaceInstructions,
              },
            }
          : {}),
        ...(operation.value.privacy
          ? { privacy: { ...policy.privacy, ...operation.value.privacy } }
          : {}),
        ...(operation.value.webSearch
          ? { webSearch: { ...policy.webSearch, ...operation.value.webSearch } }
          : {}),
      };
  }
}
