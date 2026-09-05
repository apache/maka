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

import type {
  AgentRuntimeSettingsPatch,
  MutateRuntimePolicyInput,
  RuntimePolicy,
  RuntimePolicySnapshot,
} from '@maka/core/runtime-policy';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { z } from 'zod';

const personalizationPatchSchema = z
  .object({
    displayName: z.string().max(256).optional(),
    assistantTone: z.string().max(4_096).optional(),
  })
  .strict();
const memoryPatchSchema = z
  .object({ enabled: z.boolean().optional(), agentReadEnabled: z.boolean().optional() })
  .strict();
const enabledPatchSchema = z.object({ enabled: z.boolean().optional() }).strict();
const privacyPatchSchema = z.object({ incognitoActive: z.boolean().optional() }).strict();

const agentSettingsPatchSchema = z
  .object({
    personalization: personalizationPatchSchema.optional(),
    memory: memoryPatchSchema.optional(),
    workspaceInstructions: enabledPatchSchema.optional(),
    privacy: privacyPatchSchema.optional(),
    webSearch: enabledPatchSchema.optional(),
  })
  .strict();

type AgentSettingsPatch = z.infer<typeof agentSettingsPatchSchema>;

export interface HostAgentSettingsToolAuthority {
  read(): Promise<RuntimePolicySnapshot>;
  mutate(input: MutateRuntimePolicyInput): Promise<
    | { readonly kind: 'committed'; readonly revision: number }
    | {
        readonly kind: 'revision_conflict';
        readonly expectedRevision: number;
        readonly actualRevision: number;
      }
  >;
}

export interface AgentSettingsSnapshot {
  readonly personalization: RuntimePolicy['personalization'];
  readonly memory: RuntimePolicy['memory'];
  readonly workspaceInstructions: RuntimePolicy['workspaceInstructions'];
  readonly privacy: RuntimePolicy['privacy'];
  readonly webSearch: Pick<RuntimePolicy['webSearch'], 'enabled'>;
}

type AgentSettingsUpdateResult =
  | {
      readonly kind: 'maka_settings_update';
      readonly ok: true;
      readonly applied: boolean;
      readonly reason?: 'cancelled';
      readonly changes?: readonly string[];
      readonly message: string;
      readonly settings: AgentSettingsSnapshot;
    }
  | {
      readonly kind: 'maka_settings_update';
      readonly ok: false;
      readonly applied: false;
      readonly reason: 'confirmation_unavailable';
      readonly message: string;
      readonly settings: AgentSettingsSnapshot;
    };

/** Build the model-visible settings surface over the Host's canonical Runtime Policy. */
export function buildHostAgentSettingsTools(
  authority: HostAgentSettingsToolAuthority,
): readonly MakaTool[] {
  const getTool: MakaTool<Record<string, never>, AgentSettingsSnapshot> = {
    name: 'MakaSettingsGet',
    displayName: 'Read Maka settings',
    description:
      'Read the safe, non-secret Runtime settings that Maka may help configure. ' +
      'This never returns credentials, network proxy details, native client settings, or Bot settings.',
    parameters: z.object({}).strict(),
    categoryHint: 'read',
    recoveryMode: 'replay_safe',
    impl: async () => projectSettings((await authority.read()).policy),
  };
  const updateTool: MakaTool<AgentSettingsPatch, AgentSettingsUpdateResult> = {
    name: 'MakaSettingsUpdate',
    displayName: 'Update Maka settings',
    description:
      'Update the safe, non-secret Runtime settings owned by the Runtime Host. ' +
      'Use only when the user explicitly asks to change Maka itself. Every effective change requires confirmation.',
    parameters: agentSettingsPatchSchema,
    categoryHint: 'custom_tool',
    recoveryMode: 'never_auto_retry',
    executionSemantics: 'exclusive_step',
    impl: async (patch, context) => {
      const initial = await authority.read();
      const changes = describeChanges(initial.policy, patch);
      if (changes.length === 0) return unchanged(initial.policy);
      if (!context.askUserQuestion) {
        return {
          kind: 'maka_settings_update',
          ok: false,
          applied: false,
          reason: 'confirmation_unavailable',
          message: 'Maka settings were not changed because confirmation is unavailable.',
          settings: projectSettings(initial.policy),
        };
      }
      const answer = await context.askUserQuestion([
        {
          question: `Apply these Maka setting changes?\n${changes.map((change) => `• ${change}`).join('\n')}`,
          options: [
            { label: 'Apply changes', description: 'Persist the listed Maka settings now.' },
            { label: 'Cancel', description: 'Leave every setting unchanged.' },
          ],
        },
      ]);
      if (answer.answers[0]?.answer !== 'Apply changes') {
        const current = await authority.read();
        return {
          kind: 'maka_settings_update',
          ok: true,
          applied: false,
          reason: 'cancelled',
          message: 'Maka settings were not changed.',
          settings: projectSettings(current.policy),
        };
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = attempt === 0 ? initial : await authority.read();
        if (describeChanges(current.policy, patch).length === 0) return unchanged(current.policy);
        const result = await authority.mutate({
          expectedRevision: current.revision,
          operation: { kind: 'patch_agent_settings', value: patch },
        });
        if (result.kind !== 'committed') continue;
        const updated = await authority.read();
        return {
          kind: 'maka_settings_update',
          ok: true,
          applied: true,
          changes,
          message: `Updated ${changes.length} Maka setting${changes.length === 1 ? '' : 's'}.`,
          settings: projectSettings(updated.policy),
        };
      }
      throw new Error('Runtime Policy kept changing while Maka settings were updated');
    },
  };
  return [getTool, updateTool];
}

function unchanged(policy: RuntimePolicy): AgentSettingsUpdateResult {
  return {
    kind: 'maka_settings_update',
    ok: true,
    applied: false,
    message: 'The requested Maka settings already have those values.',
    settings: projectSettings(policy),
  };
}

function projectSettings(policy: RuntimePolicy): AgentSettingsSnapshot {
  return {
    personalization: { ...policy.personalization },
    memory: { ...policy.memory },
    workspaceInstructions: { ...policy.workspaceInstructions },
    privacy: { ...policy.privacy },
    webSearch: { enabled: policy.webSearch.enabled },
  };
}

function describeChanges(policy: RuntimePolicy, patch: AgentRuntimeSettingsPatch): string[] {
  const changes: string[] = [];
  compare(
    changes,
    'Display name',
    policy.personalization.displayName,
    patch.personalization?.displayName,
  );
  compare(
    changes,
    'Assistant tone',
    policy.personalization.assistantTone,
    patch.personalization?.assistantTone,
  );
  compare(changes, 'Memory', policy.memory.enabled, patch.memory?.enabled);
  compare(
    changes,
    'Agent memory access',
    policy.memory.agentReadEnabled,
    patch.memory?.agentReadEnabled,
  );
  compare(
    changes,
    'Workspace instructions',
    policy.workspaceInstructions.enabled,
    patch.workspaceInstructions?.enabled,
  );
  compare(
    changes,
    'Incognito mode',
    policy.privacy.incognitoActive,
    patch.privacy?.incognitoActive,
  );
  compare(changes, 'Web search', policy.webSearch.enabled, patch.webSearch?.enabled);
  return changes;
}

function compare(
  changes: string[],
  label: string,
  current: string | boolean,
  next: string | boolean | undefined,
): void {
  if (next !== undefined && next !== current)
    changes.push(`${label}: ${String(current)} → ${String(next)}`);
}
