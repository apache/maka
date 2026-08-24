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

import type { ArtifactRecord } from '@maka/core/artifacts';

import type { ArtifactStore } from './artifact-store.js';

export interface PersistProviderRequestCaptureArtifactInput {
  sessionId: string;
  turnId: string;
  captureId: string;
  step: number;
  serializedRequest: string;
  now?: number;
}

export function persistProviderRequestCaptureArtifact(
  store: Pick<ArtifactStore, 'create'>,
  input: PersistProviderRequestCaptureArtifactInput,
): Promise<ArtifactRecord> {
  return store.create({
    sessionId: input.sessionId,
    turnId: input.turnId,
    name: `provider-request-step-${input.step}-${input.captureId}.json`,
    kind: 'file',
    content: input.serializedRequest,
    mimeType: 'application/json',
    source: 'provider_request_capture',
    summary: `Prepared provider request for step ${input.step}`,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
}
