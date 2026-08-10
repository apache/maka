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

import { isNonLoopbackCleartextHttp } from '@maka/core/mcp';
import { parseCommandLine } from './mcp-command-line.js';

export type McpEditorDraft = {
  id: string;
  kind: 'stdio' | 'remote';
  commandLine: string;
  url: string;
  headers: string;
};

export type McpEditorValidationCode =
  | 'required'
  | 'invalid-url'
  | 'insecure-url'
  | 'url-credentials'
  | 'unbalanced-quote'
  | 'duplicate-id'
  | 'oauth-authorization-conflict';
export type McpEditorErrors = Partial<
  Record<'id' | 'commandLine' | 'url' | 'headers', McpEditorValidationCode>
>;

export function validateMcpEditorDraft(
  draft: McpEditorDraft,
  options: {
    /** Server ids that would be silently overwritten by an upsert. Passed
     * only in add mode — an edit legitimately writes over its own id. */
    existingIds?: readonly string[];
    /** Whether the draft carries an (invisible, opaquely round-tripped)
     * oauth block. The store rejects an Authorization header alongside it;
     * the dialog mirrors that rule as a field error instead of letting the
     * save bounce off main as a raw untranslated toast. */
    hasOAuth?: boolean;
  } = {},
): McpEditorErrors {
  const errors: McpEditorErrors = {};
  const id = draft.id.trim();
  if (!id) errors.id = 'required';
  else if (options.existingIds?.includes(id)) errors.id = 'duplicate-id';

  if (draft.kind === 'stdio') {
    const parsed = parseCommandLine(draft.commandLine);
    if (!parsed.ok) {
      errors.commandLine = 'unbalanced-quote';
    } else if (!parsed.command.trim()) {
      errors.commandLine = 'required';
    }
    return errors;
  }

  const value = draft.url.trim();
  if (!value) {
    errors.url = 'required';
    return errors;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      errors.url = 'invalid-url';
    } else if (isNonLoopbackCleartextHttp(url)) {
      // The store enforces the same shared rule; validating here puts the
      // error on the URL field instead of an opaque save toast.
      errors.url = 'insecure-url';
    } else if (url.username || url.password) {
      // Mirrors the store's embedded-credentials rejection for the same
      // reason: live on the field, not a generic save-failure toast.
      errors.url = 'url-credentials';
    }
  } catch {
    errors.url = 'invalid-url';
  }
  if (
    options.hasOAuth &&
    draft.headers
      .split(/\r?\n/u)
      .some((line) => line.split('=')[0]?.trim().toLowerCase() === 'authorization')
  ) {
    errors.headers = 'oauth-authorization-conflict';
  }
  return errors;
}
