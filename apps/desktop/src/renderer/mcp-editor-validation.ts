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

import { parseCommandLine } from './mcp-command-line.js';

export type McpEditorDraft = {
  id: string;
  kind: 'stdio' | 'remote';
  commandLine: string;
  url: string;
};

export type McpEditorValidationCode =
  | 'required'
  | 'invalid-url'
  | 'unbalanced-quote';
export type McpEditorErrors = Partial<
  Record<'id' | 'commandLine' | 'url', McpEditorValidationCode>
>;

export function validateMcpEditorDraft(
  draft: McpEditorDraft,
): McpEditorErrors {
  const errors: McpEditorErrors = {};
  if (!draft.id.trim()) errors.id = 'required';

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
    }
  } catch {
    errors.url = 'invalid-url';
  }
  return errors;
}
