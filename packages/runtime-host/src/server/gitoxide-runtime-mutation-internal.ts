/* Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See the NOTICE file distributed with this
 * work for additional information regarding copyright ownership. The ASF
 * licenses this file to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import type { PreparedManagedMutation } from '@maka/runtime/tool-runtime';
import type { InteractiveExecutionStoresWriter } from '@maka/storage/execution-stores';
import type { GitoxideMutationAdmissionInput } from './gitoxide-mutation-admission-internal.js';
import { createGitoxideWorkspaceBaselineOwnerInternal } from './gitoxide-workspace-baseline-owner-internal.js';
import { createGitoxideCandidateInternal } from './gitoxide-repository-admission-authority-internal.js';
import { encodeCanonicalRuntimeEvent } from '@maka/core/canonical-runtime-event';

/** Internal adapter. The runtime never delegates its operation or provider value. */
export async function prepareGitoxideRuntimeMutationInternal(
  stores: InteractiveExecutionStoresWriter,
  input: GitoxideMutationAdmissionInput,
): Promise<PreparedManagedMutation> {
  input = { ...input };
  const owner = createGitoxideWorkspaceBaselineOwnerInternal(stores);
  const admission = await owner.prepareMutation(input);
  const binding = Object.freeze({
    workspaceKey: input.workspaceKey,
    acceptedRepositoryOwnerToken: input.acceptedRepositoryOwnerToken,
    acceptedRepositoryCapability: input.acceptedRepositoryCapability,
  });
  return Object.freeze({
    ...admission,
    async commitOutcome(original, result) {
      const toolOutcome = {
        ...original,
        runtimeEvent: encodeCanonicalRuntimeEvent(original.runtimeEvent).event,
      };
      if (result === null) {
        await owner.acceptRejectedOperation({ ...binding, toolOutcome });
      } else {
        // No caller signal after T1: finish this bounded pure-operation
        // settlement, or leave its durable reservation for reconciliation.
        const candidateOwnerToken = {};
        const candidate = await createGitoxideCandidateInternal({
          ...binding,
          candidateOwnerToken,
          operationId: toolOutcome.operationId,
          path: admission.mutation.expectedPath,
          content: result.content,
        });
        const settlement = {
          ...binding,
          candidateOwnerToken,
          candidateOutcomeCapability: candidate.candidateOutcomeCapability,
          toolOutcome,
        };
        if (result.changed) await owner.acceptPublishedCandidate(settlement);
        else await owner.acceptUnchangedCandidate(settlement);
      }
      return toolOutcome.runtimeEvent;
    },
  } satisfies PreparedManagedMutation);
}
