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

import { createHash } from 'node:crypto';
import { DEFAULT_IMAGE_ARCHIVE_LIMITS, type ImageArchiveLimits } from '@maka/core/image-delivery';
import type { InteractiveArtifactStoreWriter } from '@maka/storage/artifact-stores';
import type { ChatImageBytes } from './chat-image-source.js';

/** Build the shared ready record; callers own admission, identity and failures. */
export function readyChatImageArtifact(input: {
  id: string;
  sessionId: string;
  turnId: string;
  name: string;
  messageId: string;
  source: string;
  image: ChatImageBytes;
  summary?: string;
  limits?: ImageArchiveLimits;
}): Parameters<InteractiveArtifactStoreWriter['create']>[0] {
  return {
    id: input.id,
    sessionId: input.sessionId,
    turnId: input.turnId,
    name: input.name,
    kind: 'image',
    content: input.image.bytes,
    mimeType: input.image.mimeType,
    source: 'tool_result_projection',
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    imageDelivery: {
      messageId: input.messageId,
      source: input.source,
      status: 'ready',
      contentSha256: createHash('sha256').update(input.image.bytes).digest('hex'),
    },
    imageArchiveLimits: input.limits ?? DEFAULT_IMAGE_ARCHIVE_LIMITS,
  };
}
