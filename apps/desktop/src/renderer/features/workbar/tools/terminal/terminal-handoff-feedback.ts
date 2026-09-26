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

import { isWellFormedTerminalInput } from '@maka/core/terminal-input';

/** Renderer-only hints. Never return raw output, publish it, or infer success. */
type TerminalHint = 'password' | 'authentication_retry';
interface TerminalFeedbackAdapter {
  matches(command: string): boolean;
  observe(text: string): TerminalHint | undefined;
}

// Each adapter must be validated against its actual program. Unknown commands,
// compound shell commands, locales and prompts retain the raw private response.
const adapters: readonly TerminalFeedbackAdapter[] = [{
  matches: (command) => /^(?:\/usr\/bin\/)?ssh\s/.test(command.trim()) && !/[;&|`\n]/.test(command),
  observe(text) {
    const lines = text.trimEnd().split('\n');
    if (!/^[^\r\n]*'s password:\s*$/.test(lines.at(-1) ?? '')) return;
    return lines.at(-2)?.trim() === 'Permission denied, please try again.'
      ? 'authentication_retry' : 'password';
  },
}];

export function terminalFeedback(command: string, text: string): TerminalHint | undefined {
  return adapters.find((adapter) => adapter.matches(command))?.observe(text);
}

export function isValidPrivateTerminalInput(value: string): boolean {
  return Boolean(value) && isWellFormedTerminalInput(value) && !/[\x00-\x1f\x7f]/.test(value) &&
    new TextEncoder().encode(value).length <= 32 * 1024;
}
