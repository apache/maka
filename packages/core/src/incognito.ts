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

/** Main-owned workspace privacy state. Invalid boundary data fails closed. */

export interface WorkspacePrivacyContext {
  /** Renderers may read this value but cannot claim write authority. */
  incognitoActive: boolean;
}

export type WorkspacePrivacyContextResult =
  | { ok: true; value: WorkspacePrivacyContext }
  | { ok: false; reason: WorkspacePrivacyContextInvalidReason; message: string };

export type WorkspacePrivacyContextInvalidReason = 'not_object' | 'incognito_active_invalid';

/** Validate and strip a privacy payload without inventing a default. */
export function validateWorkspacePrivacyContext(input: unknown): WorkspacePrivacyContextResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      ok: false,
      reason: 'not_object',
      message: 'WorkspacePrivacyContext must be an object',
    };
  }
  const record = input as Record<string, unknown>;
  if (typeof record.incognitoActive !== 'boolean') {
    return {
      ok: false,
      reason: 'incognito_active_invalid',
      message: 'WorkspacePrivacyContext.incognitoActive must be a boolean',
    };
  }
  return { ok: true, value: { incognitoActive: record.incognitoActive } };
}
