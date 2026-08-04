import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { buildCliSystemPrompt, buildCliTurnTailPrompt } from '../cli-system-prompt.js';
import type { HostCapabilities } from '@maka/runtime';

describe('CLI system prompt', () => {
  test('injects the skill catalog from workspaceRoot, gated by host capabilities', async () => {
    await withCwdAndWorkspace(async ({ cwd, workspaceRoot, homeDir }) => {
      await writeSkill(
        workspaceRoot,
        'plain-helper',
        `---
name: Plain Helper
description: Plain work.
allowed-tools: [Read]
---
# Plain Helper
Plain work.`,
      );
      await writeSkill(
        workspaceRoot,
        'gated-helper',
        `---
name: Gated Helper
description: Host-specific work.
allowed-tools: [Read]
required-tools: [ImaginaryTool]
---
# Gated Helper
Use host tools.`,
      );

      // CLI host without the required tool: gated-helper is hidden, plain-helper is shown.
      // workspaceRoot is separate from cwd so the project directory is never scanned.
      const cliHost: HostCapabilities = { toolNames: new Set(['Read']) };
      const out = await buildCliSystemPrompt({
        settings: { personalization: {}, workspaceInstructions: { enabled: false } },
        cwd,
        workspaceRoot,
        host: cliHost,
        homeDir,
      });
      assert.ok(out, 'prompt should include the plain skill catalog');
      assert.match(out, /<available-skill id="plain-helper"/);
      assert.doesNotMatch(out, /<available-skill id="gated-helper"/);

      // Host with the required tool: both skills are shown.
      const fullHost: HostCapabilities = { toolNames: new Set(['Read', 'ImaginaryTool']) };
      const full = await buildCliSystemPrompt({
        settings: { personalization: {}, workspaceInstructions: { enabled: false } },
        cwd,
        workspaceRoot,
        host: fullHost,
        homeDir,
      });
      assert.ok(full);
      assert.match(full, /<available-skill id="plain-helper"/);
      assert.match(full, /<available-skill id="gated-helper"/);
    });
  });

  test('discovers skills from .agents/skills and .maka/skills at project and user level', async () => {
    await withCwdAndWorkspace(async ({ cwd, workspaceRoot, homeDir }) => {
      // Project-level cross-client skill
      await writeSkillAt(
        cwd,
        '.agents',
        'skills',
        'cross-client-skill',
        `---
name: Cross Client Skill
description: From .agents/skills at project level.
---
# Cross Client Skill
Body.`,
      );

      // User-level maka skill
      await writeSkillAt(
        homeDir,
        '.maka',
        'skills',
        'user-skill',
        `---
name: User Skill
description: From ~/.maka/skills at user level.
---
# User Skill
Body.`,
      );

      // Workspace-level skill (existing path)
      await writeSkill(
        workspaceRoot,
        'ws-skill',
        `---
name: Workspace Skill
description: From workspaceRoot/skills.
---
# Workspace Skill
Body.`,
      );

      const out = await buildCliSystemPrompt({
        settings: { personalization: {}, workspaceInstructions: { enabled: false } },
        cwd,
        workspaceRoot,
        homeDir,
      });

      assert.ok(out);
      assert.match(out, /<available-skill id="cross-client-skill"/);
      assert.match(out, /<available-skill id="user-skill"/);
      assert.match(out, /<available-skill id="ws-skill"/);
    });
  });

  test('project-level skill overrides user-level skill with the same id', async () => {
    await withCwdAndWorkspace(async ({ cwd, workspaceRoot, homeDir }) => {
      // User-level skill (lower precedence)
      await writeSkillAt(
        homeDir,
        '.agents',
        'skills',
        'shared-skill',
        `---
name: Shared Skill
description: User-level copy.
---
# Shared Skill
User body.`,
      );

      // Project-level skill with the same id (higher precedence)
      await writeSkillAt(
        cwd,
        '.agents',
        'skills',
        'shared-skill',
        `---
name: Shared Skill
description: Project-level copy.
---
# Shared Skill
Project body.`,
      );

      const out = await buildCliSystemPrompt({
        settings: { personalization: {}, workspaceInstructions: { enabled: false } },
        cwd,
        workspaceRoot,
        homeDir,
      });

      assert.ok(out);
      assert.match(out, /<available-skill id="shared-skill"/);
      assert.match(out, /Project-level copy\./);
      assert.doesNotMatch(out, /User-level copy\./);
    });
  });

  test('includes AGENTS.md content when workspaceInstructions is enabled and the file is present', async () => {
    await withCwd(async (cwd, homeDir) => {
      await writeFile(join(cwd, 'AGENTS.md'), '# Project rules\n- Use TDD always\n');
      const out = await buildCliSystemPrompt({
        settings: { personalization: {}, workspaceInstructions: { enabled: true } },
        cwd,
        workspaceRoot: cwd,
        homeDir,
      });
      assert.ok(out, 'expected a prompt fragment when AGENTS.md is present and enabled');
      assert.match(out, /Use TDD always/);
      assert.match(out, /<workspace-instructions file="AGENTS\.md" scope="project">/);
    });
  });

  test('suppresses workspace instructions when the setting is disabled, even if AGENTS.md exists', async () => {
    await withCwd(async (cwd, homeDir) => {
      await writeFile(join(cwd, 'AGENTS.md'), '- secret project rule');
      const out = await buildCliSystemPrompt({
        settings: { personalization: {}, workspaceInstructions: { enabled: false } },
        cwd,
        workspaceRoot: cwd,
        homeDir,
      });
      assert.equal(
        out,
        undefined,
        'gate must suppress AGENTS.md when workspaceInstructions is disabled',
      );
    });
  });

  test('includes the personalization addressing hint when a displayName is set', async () => {
    await withCwd(async (cwd, homeDir) => {
      const out = await buildCliSystemPrompt({
        settings: {
          personalization: { displayName: 'Yuhan' },
          workspaceInstructions: { enabled: false },
        },
        cwd,
        workspaceRoot: cwd,
        homeDir,
      });
      assert.ok(out);
      assert.match(out, /addressed as "Yuhan"/);
    });
  });

  test('returns undefined when there is no personalization and no readable instruction file', async () => {
    await withCwd(async (cwd, homeDir) => {
      const out = await buildCliSystemPrompt({
        settings: { personalization: {}, workspaceInstructions: { enabled: true } },
        cwd,
        workspaceRoot: cwd,
        homeDir,
      });
      assert.equal(out, undefined);
    });
  });

  test('joins personalization and workspace instructions into one prompt', async () => {
    await withCwd(async (cwd, homeDir) => {
      await writeFile(join(cwd, 'AGENTS.md'), '- commit one reason');
      const out = await buildCliSystemPrompt({
        settings: {
          personalization: { displayName: 'Alice' },
          workspaceInstructions: { enabled: true },
        },
        cwd,
        workspaceRoot: cwd,
        homeDir,
      });
      assert.ok(out);
      assert.match(out, /addressed as "Alice"/);
      assert.match(out, /commit one reason/);
    });
  });
});

describe('CLI turn-tail prompt', () => {
  test('renders the working directory, git repo status, platform, and date', async () => {
    await withCwd(async (cwd) => {
      const out = await buildCliTurnTailPrompt({ cwd });
      assert.ok(out.includes(cwd), 'tail should contain the cwd');
      assert.match(out, /Git repository:/);
      assert.match(out, /Platform:/);
      assert.match(out, /Today's date:/);
    });
  });
});

async function withCwd(fn: (cwd: string, homeDir: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'maka-cli-sysprompt-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'maka-cli-sysprompt-home-'));
  try {
    await fn(cwd, homeDir);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function withCwdAndWorkspace(
  fn: (dirs: { cwd: string; workspaceRoot: string; homeDir: string }) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'maka-cli-sysprompt-cwd-'));
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-cli-sysprompt-ws-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'maka-cli-sysprompt-home-'));
  try {
    await fn({ cwd, workspaceRoot, homeDir });
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function writeSkill(workspaceRoot: string, id: string, content: string): Promise<void> {
  const dir = join(workspaceRoot, 'skills', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), content, 'utf8');
}

async function writeSkillAt(base: string, ...parts: string[]): Promise<void> {
  const content = parts.pop()!;
  const id = parts.pop()!;
  const dir = join(base, ...parts, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), content, 'utf8');
}
