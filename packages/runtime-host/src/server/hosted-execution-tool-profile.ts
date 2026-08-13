import type { HostedExecutionToolProfile } from '../protocol/index.js';

const HEADLESS_CODING_V1_TOOL_NAMES = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'apply_patch',
] as const;

export function hostedExecutionToolNames(profile: HostedExecutionToolProfile): readonly string[] {
  if (profile === 'headless-coding-v1') return HEADLESS_CODING_V1_TOOL_NAMES;
  profile satisfies never;
  throw new Error('Unknown Hosted execution tool profile');
}

export class HostedExecutionToolProfileRegistry {
  readonly #profiles = new Map<string, HostedExecutionToolProfile>();

  async run<T>(
    executionId: string,
    profile: HostedExecutionToolProfile | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!profile) return await operation();
    if (this.#profiles.has(executionId)) {
      throw new Error('Hosted execution tool profile is already registered');
    }
    this.#profiles.set(executionId, profile);
    try {
      return await operation();
    } finally {
      this.#profiles.delete(executionId);
    }
  }

  toolNamesFor(executionId: string): readonly string[] | undefined {
    const profile = this.#profiles.get(executionId);
    return profile ? hostedExecutionToolNames(profile) : undefined;
  }
}
