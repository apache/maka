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

import type { MakaTool } from '@maka/runtime/tool-runtime';
import { z } from 'zod';
import type { ArtifactPreviewEndpoint } from './managed-artifact-preview.js';

export function buildManagedArtifactPreviewTools(
  prepare: (sessionId: string, artifactId: string, signal: AbortSignal) => Promise<ArtifactPreviewEndpoint>,
): readonly MakaTool[] {
  const tool: MakaTool<{ artifactId: string }, ArtifactPreviewEndpoint> = {
    name: 'ArtifactPreview',
    displayName: 'Prepare HTML preview',
    description: 'Create a Desktop-managed, temporary HTTP URL for an HTML Artifact in the current session. No shell server or file:// navigation is needed. The URL is a bearer capability: do not share it. It expires after 30 minutes or when the client disconnects. Only self-contained HTML is supported: inline scripts/styles and embedded images; remote subresources, fetch requests, forms and local file access are blocked. This is not OS network isolation: an external browser can navigate away from the document. reachable confirms a Desktop HTTP check, NOT browser load. Use browser navigation and observation to verify rendering and interactions. On failure, use Generated Files → Save As or Show in Folder; do not claim the preview opened.',
    parameters: z.object({ artifactId: z.string().min(1).max(128) }).strict(),
    categoryHint: 'custom_tool',
    recoveryMode: 'never_auto_retry',
    impl: (input, context) => prepare(context.sessionId, input.artifactId, context.abortSignal),
  };
  return [tool];
}
