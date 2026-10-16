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

import { isExecutorId } from '@maka/core/executor-id';
import type { RuntimeInvocationRoute } from '@maka/core/runtime-event';
import type { SessionHeader } from '@maka/core/session';

export function runtimeInvocationRouteForHeader(
  header: SessionHeader,
  providerStateIdentity: `sha256:${string}` | undefined,
): RuntimeInvocationRoute {
  if (
    header.backend === 'plugin-executor' &&
    isExecutorId(header.executorId) &&
    providerStateIdentity
  ) {
    return {
      provenance: 'runtime',
      backendKind: header.backend,
      executorId: header.executorId,
      llmConnectionSlug: header.llmConnectionSlug,
      modelId: header.model,
      providerStateIdentity,
    };
  }
  if (header.backend !== 'plugin-executor' && header.llmConnectionId !== undefined) {
    return {
      provenance: 'runtime',
      backendKind: header.backend,
      llmConnectionId: header.llmConnectionId,
      llmConnectionSlug: header.llmConnectionSlug,
      modelId: header.model,
      ...(providerStateIdentity ? { providerStateIdentity } : {}),
    };
  }
  return {
    provenance: 'unknown',
    backendKind: header.backend,
    llmConnectionSlug: header.llmConnectionSlug,
    modelId: header.model,
  };
}
