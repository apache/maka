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
  profile satisfies never;
  throw new Error('Unknown Session tool profile');
}

export function hostedExecutionToolNames(profile: SessionToolProfile): readonly string[] {
  return hostedExecutionRunProfile(profile)!.toolNames;
}

export function projectHostedExecutionTools(
  tools: readonly MakaTool[],
  profile: SessionToolProfile | undefined,
): readonly MakaTool[] {
  if (profile === undefined) return tools;
  hostedExecutionRunProfile(profile);
  return tools.map((tool) =>
    tool.name === 'Bash'
      ? {
          ...tool,
          description: HEADLESS_CODING_V1_BASH_DESCRIPTION,
          parameters: HEADLESS_CODING_V1_BASH_PARAMETERS,
        }
      : tool,
  );
}
