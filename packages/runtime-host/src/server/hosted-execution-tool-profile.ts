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

import type { SessionToolProfile } from '@maka/core/session';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { z } from 'zod';

const HEADLESS_CODING_V1_TOOL_NAMES = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'apply_patch',
] as const;

const HEADLESS_CODING_V1_SYSTEM_PROMPT = [
  'Complete the task by acting with the available tools, not by narrating.',
  'Prefer Read, Glob, and Grep for inspection, Edit and Write for file changes, and Bash for shell commands and tests.',
  'Verify the result when practical.',
  'Stop when the task is complete.',
].join('\n');

const HEADLESS_CODING_V1_BASH_DESCRIPTION =
  'Run a foreground shell command in the session cwd. Use Bash for inspection, builds, tests, and task-local generation. Background execution and PTY sessions are unavailable in this profile.';

const HEADLESS_CODING_V1_BASH_PARAMETERS = z
  .object({
    command: z.string().describe('The shell command to execute'),
    timeout_ms: z.number().int().positive().max(600_000).optional(),
  })
  .strict();

const WORKHUB_COORDINATION_V1_SYSTEM_PROMPT = [
  'You are the conversational coordinator for WorkHub.',
  'Answer ordinary questions directly and help the user clarify intent.',
  'Reply in the language used by the user unless they ask for another language.',
  'This conversation has no tools, filesystem authority, or authority over ordinary Sessions.',
  'Never claim to have inspected files, run commands, changed a Session, or completed concrete work.',
].join(' ');

export interface HostedExecutionRunProfile {
  readonly toolNames: readonly string[];
  readonly systemPrompt: string;
  readonly memoryExtraction: boolean;
}

export function hostedExecutionRunProfile(
  profile: SessionToolProfile | undefined,
): HostedExecutionRunProfile | undefined {
  if (profile === undefined) return undefined;
  if (profile === 'headless-coding-v1') {
    return {
      toolNames: HEADLESS_CODING_V1_TOOL_NAMES,
      systemPrompt: HEADLESS_CODING_V1_SYSTEM_PROMPT,
      memoryExtraction: false,
    };
  }
  if (profile === 'workhub-coordination-v1') {
    return {
      toolNames: [],
      systemPrompt: WORKHUB_COORDINATION_V1_SYSTEM_PROMPT,
      memoryExtraction: false,
    };
  }
  profile satisfies never;
  throw new Error('Unknown Session tool profile');
}

export function projectHostedExecutionTools(
  tools: readonly MakaTool[],
  profile: SessionToolProfile | undefined,
): readonly MakaTool[] {
  if (profile === undefined) return tools;
  const toolNames = hostedExecutionRunProfile(profile)!.toolNames;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const selected = toolNames.map((name) => byName.get(name));
  const missing = toolNames.filter((_name, index) => selected[index] === undefined);
  if (missing.length > 0) {
    throw new Error(`Hosted tool profile is unavailable: ${missing.join(', ')}`);
  }
  return (selected as MakaTool[]).map((tool) =>
    tool.name === 'Bash'
      ? {
          ...tool,
          description: HEADLESS_CODING_V1_BASH_DESCRIPTION,
          parameters: HEADLESS_CODING_V1_BASH_PARAMETERS,
        }
      : tool,
  );
}
