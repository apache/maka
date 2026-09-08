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

import { createServicesContext } from '../../application/contracts/feature-services.js';
import type { WorkHubCreateDefaults } from '@maka/core/session';
import type { ChatDefaultPermissionMode } from '@maka/core/settings';

export interface WorkHubComposerPort {
  attachments: {
    pickFiles(): Promise<{ ok: true; files: Array<{ approvalId: string; name: string; mimeType?: string; size: number }> } | { ok: false; reason: 'cancelled' }>;
    previewApproval(approvalId: string): Promise<{ ok: true; base64: string; mimeType: string } | { ok: false; reason: string }>;
  };
  prepareAttachments(sessionId: string, items: Array<{ approvalId: string; name: string; mimeType?: string } | { file: File }>): Promise<import('@maka/core/events').AttachmentRef[]>;
  setModelConfiguration(sessionId: string, input: NonNullable<WorkHubCreateDefaults['model']> & { thinkingLevel: null }): Promise<unknown>;
  setPermissionMode(sessionId: string, mode: ChatDefaultPermissionMode): Promise<unknown>;
}
const { Provider, useServices } = createServicesContext<WorkHubComposerPort>('WorkHubComposerServicesProvider');
export const WorkHubComposerServicesProvider = Provider;
export const useWorkHubComposerServices = useServices;
