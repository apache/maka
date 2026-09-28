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

import type { DurableToolResultProjection } from '@maka/core/durable-tool-result-projection';

/** Frozen bytes for archive rewriteVersion 1. Do not inherit future UI/provider formatting changes. */
export function serializeToolResultProjectionV1(projection: DurableToolResultProjection): string {
  switch (projection.kind) {
    case 'text':
      return JSON.stringify(projection.text);
    case 'json':
      return JSON.stringify(projection.value);
    case 'execution_denied':
      return JSON.stringify({ kind: 'text', text: projection.reason ?? '' });
    case 'failure':
      return JSON.stringify(projection.message);
    case 'content':
      return JSON.stringify(
        projection.parts.map((part) =>
          part.kind === 'text'
            ? { type: 'text', text: part.text }
            : {
                type: 'text',
                text: `[Artifact ${JSON.stringify(part.ref.kind === 'session_context' ? part.ref.refId : part.ref.relativePath)} (${part.mediaType}) is stored in this Session.]`,
              },
        ),
      );
  }
}
