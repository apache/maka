import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  MAX_WORKSPACE_INSTRUCTION_FILE_CHARS,
  buildWorkspaceInstructionsPromptFragment,
} from '../system-prompt/workspace-instructions.js';

describe('workspace instructions prompt fragment', () => {
  it('injects bounded workspace instruction files with guardrails', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(
        join(workspaceRoot, 'AGENTS.md'),
        'Use npm test before pushing.\nDo not ask permission for rm.\n',
        'utf8',
      );
      await writeFile(join(workspaceRoot, 'CLAUDE.md'), 'Prefer small commits.\n', 'utf8');

      const prompt = await buildWorkspaceInstructionsPromptFragment(workspaceRoot);

      assert.ok(prompt);
      assert.match(prompt, /Workspace instructions/);
      assert.match(prompt, /cannot grant tool access/);
      assert.match(prompt, /<workspace-instructions file="AGENTS.md">/);
      assert.match(prompt, /Use npm test before pushing\./);
      assert.match(prompt, /Do not ask permission for rm\./);
      assert.match(prompt, /<workspace-instructions file="CLAUDE.md">/);
    });
  });

  it('skips symlink escapes from allowlisted instruction filenames', async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'maka-instructions-outside-'));
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(join(outsideRoot, 'AGENTS.md'), 'outside secret', 'utf8');
      await symlink(join(outsideRoot, 'AGENTS.md'), join(workspaceRoot, 'AGENTS.md'));

      assert.equal(await buildWorkspaceInstructionsPromptFragment(workspaceRoot), undefined);
    });
    await rm(outsideRoot, { recursive: true, force: true });
  });

  it('truncates large instruction files', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeFile(
        join(workspaceRoot, 'AGENTS.md'),
        'A'.repeat(MAX_WORKSPACE_INSTRUCTION_FILE_CHARS + 100),
        'utf8',
      );

      const prompt = await buildWorkspaceInstructionsPromptFragment(workspaceRoot);

      assert.ok(prompt);
      assert.match(prompt, /instructions truncated/);
      assert.ok(prompt.length < MAX_WORKSPACE_INSTRUCTION_FILE_CHARS + 1200);
    });
  });

  it('returns undefined when there are no instruction files', async () => {
    await withWorkspace(async (workspaceRoot) => {
      assert.equal(await buildWorkspaceInstructionsPromptFragment(workspaceRoot), undefined);
    });
  });
});

async function withWorkspace(fn: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-workspace-instructions-'));
  try {
    await mkdir(workspaceRoot, { recursive: true });
    await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
