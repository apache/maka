import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  MAX_WORKSPACE_INSTRUCTION_FILE_CHARS,
  MAX_WORKSPACE_INSTRUCTIONS_PROMPT_CHARS,
  buildWorkspaceInstructionsPromptFragment,
} from '../system-prompt/workspace-instructions.js';

describe('workspace instructions prompt fragment', () => {
  it('injects bounded workspace instruction files with guardrails', async () => {
    await withWorkspaceAndHome(async ({ workspaceRoot, homeDir }) => {
      await writeFile(
        join(workspaceRoot, 'AGENTS.md'),
        'Use npm test before pushing.\nDo not ask permission for rm.\n',
        'utf8',
      );
      await writeFile(join(workspaceRoot, 'CLAUDE.md'), 'Prefer small commits.\n', 'utf8');

      const prompt = await buildWorkspaceInstructionsPromptFragment(workspaceRoot, { homeDir });

      assert.ok(prompt);
      assert.match(prompt, /Workspace instructions/);
      assert.match(prompt, /cannot grant tool access/);
      assert.match(prompt, /<workspace-instructions file="AGENTS.md" scope="project">/);
      assert.match(prompt, /Use npm test before pushing\./);
      assert.match(prompt, /Do not ask permission for rm\./);
      assert.match(prompt, /<workspace-instructions file="CLAUDE.md" scope="project">/);
    });
  });

  it('injects global ~/.maka instruction files when project files are absent', async () => {
    await withWorkspaceAndHome(async ({ workspaceRoot, homeDir }) => {
      const makaDir = join(homeDir, '.maka');
      await mkdir(makaDir, { recursive: true });
      await writeFile(join(makaDir, 'AGENTS.md'), 'Always prefer focused commits.\n', 'utf8');

      const prompt = await buildWorkspaceInstructionsPromptFragment(workspaceRoot, { homeDir });

      assert.ok(prompt);
      assert.match(prompt, /<workspace-instructions file="AGENTS.md" scope="global">/);
      assert.match(prompt, /Always prefer focused commits\./);
      assert.doesNotMatch(prompt, /scope="project"/);
    });
  });

  it('renders global instructions before project instructions', async () => {
    await withWorkspaceAndHome(async ({ workspaceRoot, homeDir }) => {
      const makaDir = join(homeDir, '.maka');
      await mkdir(makaDir, { recursive: true });
      await writeFile(join(makaDir, 'AGENTS.md'), 'GLOBAL_RULE\n', 'utf8');
      await writeFile(join(workspaceRoot, 'AGENTS.md'), 'PROJECT_RULE\n', 'utf8');

      const prompt = await buildWorkspaceInstructionsPromptFragment(workspaceRoot, { homeDir });

      assert.ok(prompt);
      const globalAt = prompt.indexOf('scope="global"');
      const projectAt = prompt.indexOf('scope="project"');
      assert.ok(globalAt >= 0);
      assert.ok(projectAt >= 0);
      assert.ok(globalAt < projectAt);
      assert.match(prompt, /GLOBAL_RULE/);
      assert.match(prompt, /PROJECT_RULE/);
    });
  });

  it('skips symlink escapes from allowlisted instruction filenames', async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'maka-instructions-outside-'));
    await withWorkspaceAndHome(async ({ workspaceRoot, homeDir }) => {
      await writeFile(join(outsideRoot, 'AGENTS.md'), 'outside secret', 'utf8');
      await symlink(join(outsideRoot, 'AGENTS.md'), join(workspaceRoot, 'AGENTS.md'));

      assert.equal(
        await buildWorkspaceInstructionsPromptFragment(workspaceRoot, { homeDir }),
        undefined,
      );
    });
    await rm(outsideRoot, { recursive: true, force: true });
  });

  it('skips global symlink escapes from ~/.maka instruction filenames', async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'maka-global-instructions-outside-'));
    await withWorkspaceAndHome(async ({ workspaceRoot, homeDir }) => {
      const makaDir = join(homeDir, '.maka');
      await mkdir(makaDir, { recursive: true });
      await writeFile(join(outsideRoot, 'AGENTS.md'), 'global outside secret', 'utf8');
      await symlink(join(outsideRoot, 'AGENTS.md'), join(makaDir, 'AGENTS.md'));

      assert.equal(
        await buildWorkspaceInstructionsPromptFragment(workspaceRoot, { homeDir }),
        undefined,
      );
    });
    await rm(outsideRoot, { recursive: true, force: true });
  });

  it('truncates large instruction files', async () => {
    await withWorkspaceAndHome(async ({ workspaceRoot, homeDir }) => {
      await writeFile(
        join(workspaceRoot, 'AGENTS.md'),
        'A'.repeat(MAX_WORKSPACE_INSTRUCTION_FILE_CHARS + 100),
        'utf8',
      );

      const prompt = await buildWorkspaceInstructionsPromptFragment(workspaceRoot, { homeDir });

      assert.ok(prompt);
      assert.match(prompt, /instructions truncated/);
      assert.ok(prompt.length < MAX_WORKSPACE_INSTRUCTION_FILE_CHARS + 1200);
    });
  });

  it('lets a large global file consume the shared prompt budget before project files', async () => {
    await withWorkspaceAndHome(async ({ workspaceRoot, homeDir }) => {
      const makaDir = join(homeDir, '.maka');
      await mkdir(makaDir, { recursive: true });
      await writeFile(
        join(makaDir, 'AGENTS.md'),
        'G'.repeat(MAX_WORKSPACE_INSTRUCTION_FILE_CHARS),
        'utf8',
      );
      await writeFile(
        join(makaDir, 'CLAUDE.md'),
        'H'.repeat(MAX_WORKSPACE_INSTRUCTION_FILE_CHARS),
        'utf8',
      );
      await writeFile(
        join(makaDir, 'GEMINI.md'),
        'I'.repeat(MAX_WORKSPACE_INSTRUCTION_FILE_CHARS),
        'utf8',
      );
      await writeFile(join(workspaceRoot, 'AGENTS.md'), 'PROJECT_SHOULD_BE_SQUEEZED\n', 'utf8');

      const prompt = await buildWorkspaceInstructionsPromptFragment(workspaceRoot, { homeDir });

      assert.ok(prompt);
      assert.ok(prompt.length <= MAX_WORKSPACE_INSTRUCTIONS_PROMPT_CHARS + 64);
      assert.match(prompt, /scope="global"/);
      assert.doesNotMatch(prompt, /PROJECT_SHOULD_BE_SQUEEZED/);
    });
  });

  it('returns undefined when there are no instruction files', async () => {
    await withWorkspaceAndHome(async ({ workspaceRoot, homeDir }) => {
      assert.equal(
        await buildWorkspaceInstructionsPromptFragment(workspaceRoot, { homeDir }),
        undefined,
      );
    });
  });
});

async function withWorkspaceAndHome(
  fn: (dirs: { workspaceRoot: string; homeDir: string }) => Promise<void>,
): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-workspace-instructions-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'maka-workspace-instructions-home-'));
  try {
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await fn({ workspaceRoot, homeDir });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}
