import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { applyDiff } from '@openai/agents-core/utils';

export class ApplyPatchRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplyPatchRejectedError';
  }
}

export async function createPatchedFile(path: string, diff: string): Promise<void> {
  const content = patchContent('', diff, 'create');
  await fs.mkdir(dirname(path), { recursive: true });
  try {
    await fs.writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ApplyPatchRejectedError('ApplyPatch create target already exists.');
    }
    throw error;
  }
}

export async function updatePatchedFile(path: string, diff: string): Promise<void> {
  const content = await fs.readFile(path, 'utf8');
  const updated = patchContent(content, diff);
  if (updated !== content) await fs.writeFile(path, updated, 'utf8');
}

/**
 * The update transform for callers that pin the target with a file descriptor
 * (#2600): apply the diff to content already read through the handle; the
 * write happens through the caller's descriptor, not a second pathname lookup.
 */
export function applyUpdateToContent(content: string, diff: string): string {
  return patchContent(content, diff);
}

function patchContent(content: string, diff: string, mode?: 'create'): string {
  try {
    return applyDiff(content, diff, mode);
  } catch (error) {
    throw new ApplyPatchRejectedError(
      error instanceof Error ? error.message : 'ApplyPatch could not be applied.',
    );
  }
}
