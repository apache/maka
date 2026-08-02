import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_SKILL_TOOL_BODY_CHARS,
  buildSkillsPromptFragment,
  createStarterSkill,
  deleteSkill,
  installManagedSkill,
  loadSkillInstructions,
  listGovernedSkillEntries,
  listInstalledSkills,
  previewManagedSkillUpdate,
  resolveSkillOpenPath,
  setSkillEnabled,
  setSkillPinned,
  updateManagedSkill,
} from '../skills.js';
import { importManagedSkillSource } from '../managed-skill-sources.js';
import { createSystemPromptMainService } from '../system-prompt-main.js';

describe('skills ingestion', () => {
  it('applies Desktop host tool and capability gates to the system skill prompt', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'capability-helper', `---
name: Capability Helper
description: Exercise host capability gating.
allowed-tools: [Read]
required-tools: [Write]
required-capabilities: [documents]
---
# Capability Helper
Use the required tools.`);

      const makeService = (host: { toolNames: Set<string>; capabilities: Set<string> }) =>
        createSystemPromptMainService({
          settingsStore: {
            get: async () => ({
              personalization: {},
              workspaceInstructions: { enabled: false },
            }) as never,
          },
          workspaceRoot,
          localMemory: {
            getState: async () => ({ status: 'ok', agentReadEnabled: false, content: '' }) as never,
            consumePendingPromptUpdates: () => [],
          },
          taskLedger: { list: async () => [] },
          host,
        });

      const missingTool = await makeService({
        toolNames: new Set(['Read']),
        capabilities: new Set(['documents']),
      }).buildBackendSystemPrompt({ labels: [] }, workspaceRoot, { memoryFragment: null });
      assert.doesNotMatch(missingTool ?? '', /capability-helper/, 'missing required tools must hide the skill');

      const missingCapability = await makeService({
        toolNames: new Set(['Read', 'Write']),
        capabilities: new Set(),
      }).buildBackendSystemPrompt({ labels: [] }, workspaceRoot, { memoryFragment: null });
      assert.doesNotMatch(missingCapability ?? '', /capability-helper/, 'missing required capabilities must hide the skill');

      const eligible = await makeService({
        toolNames: new Set(['Read', 'Write']),
        capabilities: new Set(['documents']),
      }).buildBackendSystemPrompt({ labels: [] }, workspaceRoot, { memoryFragment: null });
      assert.ok(eligible);
      assert.match(eligible, /<available-skill id="capability-helper"/);
    });
  });

  it('persists per-workspace skill enablement and excludes disabled skills from runtime loading', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'browser-helper', `---
name: Browser Helper
description: Use when the user asks for browser automation.
---
# Browser Helper
Open local targets carefully.`);
      await writeSkill(workspaceRoot, 'deck-helper', `---
name: Deck Helper
description: Build a slide outline.
---
# Deck Helper
Make every slide carry one idea.`);

      const disabled = await setSkillEnabled(workspaceRoot, 'browser-helper', false);
      assert.equal(disabled.ok, true);
      if (!disabled.ok) return;
      assert.equal(disabled.skill.enabled, false);
      assert.equal(disabled.skill.runtimeStatus, 'disabled');

      const skills = await listInstalledSkills(workspaceRoot);
      const browserSkill = skills.find((skill) => skill.id === 'browser-helper');
      const deckSkill = skills.find((skill) => skill.id === 'deck-helper');
      assert.ok(browserSkill);
      assert.ok(deckSkill);
      assert.equal(browserSkill.enabled, false);
      assert.equal(browserSkill.runtimeStatus, 'disabled');
      assert.equal(deckSkill.enabled, true);
      assert.equal(deckSkill.runtimeStatus, 'enabled');

      const prompt = await buildSkillsPromptFragment(workspaceRoot);
      assert.ok(prompt);
      assert.doesNotMatch(prompt, /browser-helper/);
      assert.match(prompt, /deck-helper/);

      const blocked = await loadSkillInstructions(workspaceRoot, 'browser-helper');
      assert.equal(blocked.ok, false);
      if (blocked.ok) return;
      assert.equal(blocked.reason, 'disabled');
      assert.deepEqual(blocked.availableSkills.map((skill) => skill.id), ['deck-helper']);

      const enabled = await setSkillEnabled(workspaceRoot, 'browser-helper', true);
      assert.equal(enabled.ok, true);
      const loaded = await loadSkillInstructions(workspaceRoot, 'browser-helper');
      assert.equal(loaded.ok, true);
    });
  });

  it('governs project, workspace, and user scopes with stable refs and v2 pin state', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const projectRoot = join(workspaceRoot, 'project');
      const homeDir = join(workspaceRoot, 'home');
      await mkdir(projectRoot, { recursive: true });
      await mkdir(homeDir, { recursive: true });
      await writeSkill(workspaceRoot, 'workspace-helper', `---
name: Workspace Helper
description: Workspace workflow.
---
# Workspace`);
      await writeSkillAt(
        join(projectRoot, '.maka', 'skills'),
        'project-helper',
        'Project Helper',
        'Project workflow.',
      );
      await writeSkillAt(
        join(homeDir, '.agents', 'skills'),
        'user-helper',
        'User Helper',
        'User workflow.',
      );

      const options = { cwd: projectRoot, homeDir };
      const entries = await listGovernedSkillEntries(workspaceRoot, options);
      assert.deepEqual(entries.map((skill) => skill.scope).sort(), ['project', 'user', 'workspace']);
      assert.equal(entries.find((skill) => skill.id === 'project-helper')?.ref, 'project:maka:project-helper');
      // User-scope skills are the user's own installs under ~/.maka|.agents,
      // so the panel deletes them. Project-scope skills live in the repo and
      // are left to git — see isManageableSkill.
      assert.equal(entries.find((skill) => skill.id === 'user-helper')?.manageable, true);
      assert.equal(entries.find((skill) => skill.id === 'workspace-helper')?.manageable, true);
      assert.equal(entries.find((skill) => skill.id === 'project-helper')?.manageable, false);

      const pinned = await setSkillPinned(
        workspaceRoot,
        'user:agents:user-helper',
        true,
        options,
      );
      assert.equal(pinned.ok, true);
      if (!pinned.ok) return;
      assert.equal(pinned.skill.pinned, true);
      assert.equal(pinned.skill.contextRank, 1);
      const state = JSON.parse(
        await readFile(join(workspaceRoot, '.maka', 'skills-state.json'), 'utf8'),
      ) as { schemaVersion: number; skills: Record<string, { enabled: boolean; pinned: boolean }> };
      assert.equal(state.schemaVersion, 2);
      assert.deepEqual(
        {
          enabled: state.skills['user:agents:user-helper']?.enabled,
          pinned: state.skills['user:agents:user-helper']?.pinned,
        },
        { enabled: true, pinned: true },
      );
    });
  });

  it('surfaces blocked discovery roots as non-actionable inventory diagnostics', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const projectRoot = join(workspaceRoot, 'project');
      const outside = await mkdtemp(join(tmpdir(), 'maka-desktop-skill-source-'));
      try {
        await mkdir(join(projectRoot, '.maka'), { recursive: true });
        await symlink(outside, join(projectRoot, '.maka', 'skills'));
        const entries = await listGovernedSkillEntries(workspaceRoot, {
          cwd: projectRoot,
          homeDir: join(workspaceRoot, 'empty-home'),
        });
        const diagnostic = entries.find(
          (entry) => entry.kind === 'discovery_diagnostic',
        );
        assert.ok(diagnostic);
        assert.equal(diagnostic.scope, 'project');
        assert.equal(diagnostic.source, 'maka');
        assert.equal(diagnostic.discoveryDiagnosticReason, 'blocked_path');
        assert.equal(diagnostic.manageable, false);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('shows invalid discovered skills as explainable, openable inventory entries', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'broken', `---
name: Broken
---
# Missing description`);
      const entries = await listGovernedSkillEntries(workspaceRoot, {
        cwd: workspaceRoot,
        homeDir: join(workspaceRoot, 'empty-home'),
      });
      const broken = entries.find((skill) => skill.id === 'broken');
      assert.ok(broken);
      assert.equal(broken.contextStatus, 'invalid');
      assert.equal(broken.validationStatus, 'metadata_error');
      assert.equal(broken.manageable, true);
      const opened = await resolveSkillOpenPath(
        workspaceRoot,
        broken.ref,
        'file',
        { cwd: workspaceRoot, homeDir: join(workspaceRoot, 'empty-home') },
      );
      assert.equal(opened.ok, true);
    });
  });

  it('fails closed when the workspace skill runtime state file is invalid', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'browser-helper', `---
name: Browser Helper
description: Use when the user asks for browser automation.
---
# Browser Helper
Open local targets carefully.`);
      await mkdir(join(workspaceRoot, '.maka'), { recursive: true });
      await writeFile(join(workspaceRoot, '.maka', 'skills-state.json'), '{not json', 'utf8');

      const skills = await listInstalledSkills(workspaceRoot);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].enabled, false);
      assert.equal(skills[0].runtimeStatus, 'state_error');
      assert.equal(await buildSkillsPromptFragment(workspaceRoot), undefined);

      const loaded = await loadSkillInstructions(workspaceRoot, 'browser-helper');
      assert.equal(loaded.ok, false);
      if (loaded.ok) return;
      assert.equal(loaded.reason, 'disabled');
      assert.deepEqual(loaded.availableSkills, []);
      assert.deepEqual(await setSkillEnabled(workspaceRoot, 'browser-helper', true), { ok: false, reason: 'state_error' });
    });
  });

  it('does not write skill runtime state through a symlinked workspace metadata directory', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-skill-state-outside-'));
      try {
        await writeSkill(workspaceRoot, 'browser-helper', `---
name: Browser Helper
description: Use when the user asks for browser automation.
---
# Browser Helper
Open local targets carefully.`);
        await symlink(outside, join(workspaceRoot, '.maka'));

        assert.deepEqual(await setSkillEnabled(workspaceRoot, 'browser-helper', false), { ok: false, reason: 'blocked_path' });
        await assert.rejects(readFile(join(outside, 'skills-state.json'), 'utf8'), { code: 'ENOENT' });

        const skills = await listInstalledSkills(workspaceRoot);
        assert.equal(skills.length, 1);
        assert.equal(skills[0].enabled, false);
        assert.equal(skills[0].runtimeStatus, 'state_error');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('does not read or write skill runtime state through a symlinked state file', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-skill-state-file-outside-'));
      try {
        await writeSkill(workspaceRoot, 'browser-helper', `---
name: Browser Helper
description: Use when the user asks for browser automation.
---
# Browser Helper
Open local targets carefully.`);
        await mkdir(join(workspaceRoot, '.maka'), { recursive: true });
        const externalState = join(outside, 'skills-state.json');
        await writeFile(externalState, 'outside state', 'utf8');
        await symlink(externalState, join(workspaceRoot, '.maka', 'skills-state.json'));

        const skills = await listInstalledSkills(workspaceRoot);
        assert.equal(skills.length, 1);
        assert.equal(skills[0].enabled, false);
        assert.equal(skills[0].runtimeStatus, 'state_error');
        assert.equal(await buildSkillsPromptFragment(workspaceRoot), undefined);
        assert.deepEqual(await setSkillEnabled(workspaceRoot, 'browser-helper', false), { ok: false, reason: 'blocked_path' });
        assert.equal(await readFile(externalState, 'utf8'), 'outside state');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('bounds loaded skill instructions and returns available skills on miss', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'huge', `---
name: Huge
description: Exercise instruction truncation.
---
# Huge
${'A'.repeat(MAX_SKILL_TOOL_BODY_CHARS + 1000)}`);

      const loaded = await loadSkillInstructions(workspaceRoot, 'huge');
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;
      assert.equal(loaded.skill.truncated, true);
      assert.ok(loaded.skill.instructions.length <= MAX_SKILL_TOOL_BODY_CHARS + '[skill truncated]'.length + 2);
      assert.match(loaded.skill.instructions, /\[skill truncated\]/);

      const miss = await loadSkillInstructions(workspaceRoot, 'missing');
      assert.equal(miss.ok, false);
      if (miss.ok) return;
      assert.equal(miss.reason, 'not_found');
      assert.deepEqual(miss.availableSkills, [{ id: 'huge', name: 'Huge', description: 'Exercise instruction truncation.' }]);
    });
  });

  it('creates a guarded starter SKILL.md template', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const result = await createStarterSkill(workspaceRoot);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.created, true);
      assert.equal(result.skill.id, 'starter-skill');
      assert.equal(result.skill.name, '示例技能');
      assert.equal(result.skill.path, join(workspaceRoot, 'skills', 'starter-skill'));
      assert.equal(result.filePath, join(workspaceRoot, 'skills', 'starter-skill', 'SKILL.md'));
      await assert.rejects(readFile(join(workspaceRoot, 'skills', 'starter-skill', 'skill.lock.json'), 'utf8'), {
        code: 'ENOENT',
      });

      const text = await readFile(result.filePath, 'utf8');
      assert.equal(
        text,
        `---
name: 示例技能
description: 把常用工作流写成可复用的本地指令。
allowed-tools:
  - Read
---

# 示例技能

当用户要求你按固定流程完成某类任务时，先加载这个技能。

## 使用方式

1. 先确认用户的目标、输入材料和交付格式。
2. 阅读必要的本地文件或上下文，只收集完成任务需要的信息。
3. 按步骤输出结果；如果需要改文件，先说明要改哪里和原因。

## 边界

- 这个技能声明的工具只是需求提示，不会自动获得权限。
- 不要把敏感内容写进这里；它会作为本地技能指令进入模型上下文。
- 如果这个模板不适合你的工作流，可以直接改名或删除 starter-skill。
`,
      );

      const skillsDirMode = (await lstat(join(workspaceRoot, 'skills'))).mode & 0o077;
      const fileMode = (await lstat(result.filePath)).mode & 0o077;
      if (process.platform !== 'win32') {
        assert.equal(skillsDirMode, 0);
        assert.equal(fileMode, 0);
      }

      const skills = await listInstalledSkills(workspaceRoot);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].id, 'starter-skill');
      assert.equal(skills[0].sourceType, 'workspace');
      assert.equal(skills[0].validationStatus, 'missing_lock');

      // Idempotent seeding: a repeat create REUSES the existing starter-skill
      // (created:false) instead of minting a duplicate — three clicks used to
      // produce three indistinguishable 「示例技能」 rows. No new dir appears.
      const second = await createStarterSkill(workspaceRoot);
      assert.equal(second.ok, true);
      if (second.ok) {
        assert.equal(second.created, false);
        assert.equal(second.skill.id, 'starter-skill');
        assert.equal(second.filePath, join(workspaceRoot, 'skills', 'starter-skill', 'SKILL.md'));
      }
      const dirs = (await readdir(join(workspaceRoot, 'skills'), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      assert.deepEqual(dirs, ['starter-skill']);
    });
  });

  it('deletes a user-scope skill by ref and leaves project-scope skills alone', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const projectRoot = join(workspaceRoot, 'project');
      const homeDir = join(workspaceRoot, 'home');
      await mkdir(projectRoot, { recursive: true });
      await mkdir(homeDir, { recursive: true });
      await writeSkillAt(join(homeDir, '.agents', 'skills'), 'user-helper', 'User Helper', 'User workflow.');
      await writeSkillAt(join(projectRoot, '.maka', 'skills'), 'project-helper', 'Project Helper', 'Project workflow.');
      const options = { cwd: projectRoot, homeDir };

      assert.deepEqual(
        await deleteSkill(workspaceRoot, 'user:agents:user-helper', options),
        { ok: true },
      );
      await assert.rejects(lstat(join(homeDir, '.agents', 'skills', 'user-helper')), { code: 'ENOENT' });

      // Project scope is a policy refusal, not a path block, and the repo file
      // must still be on disk afterwards.
      assert.deepEqual(
        await deleteSkill(workspaceRoot, 'project:maka:project-helper', options),
        { ok: false, reason: 'blocked_scope' },
      );
      await lstat(join(projectRoot, '.maka', 'skills', 'project-helper'));

      // A ref for a skill that no longer exists is a clean not_found.
      assert.deepEqual(
        await deleteSkill(workspaceRoot, 'user:agents:user-helper', options),
        { ok: false, reason: 'not_found' },
      );
    });
  });

  it('refuses to delete a user-scope skill reached through a symlinked directory', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-skill-user-delete-outside-'));
      try {
        const homeDir = join(workspaceRoot, 'home');
        // A real skill outside the scan roots, linked into ~/.agents/skills.
        await writeSkillAt(outside, 'linked-helper', 'Linked Helper', 'Linked workflow.');
        await mkdir(join(homeDir, '.agents', 'skills'), { recursive: true });
        await symlink(join(outside, 'linked-helper'), join(homeDir, '.agents', 'skills', 'linked-helper'));

        const options = { cwd: workspaceRoot, homeDir };
        // `not_found`, not `blocked_path`: discovery itself skips symlinked
        // dir entries, so a linked skill never reaches the inventory and the
        // delete has no ref to match. The lstat symlink guard inside
        // deleteSkillByRef is defence in depth behind this.
        assert.deepEqual(
          await deleteSkill(workspaceRoot, 'user:agents:linked-helper', options),
          { ok: false, reason: 'not_found' },
        );
        // The link target survives — deletion never followed the link out.
        await lstat(join(outside, 'linked-helper', 'SKILL.md'));
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('refuses a ref that resolves outside the enumerated discovery dirs', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const homeDir = join(workspaceRoot, 'home');
      await mkdir(homeDir, { recursive: true });
      await writeSkillAt(join(homeDir, '.agents', 'skills'), 'user-helper', 'User Helper', 'User workflow.');
      const options = { cwd: workspaceRoot, homeDir };

      // Refs are matched against the scan, so a forged one never resolves to a
      // path at all — no traversal, no delete.
      for (const forged of [
        'user:agents:../../../etc',
        'user:agents:user-helper/../../..',
        'custom:0:user-helper',
        'workspace:legacy:user-helper',
      ]) {
        assert.deepEqual(
          await deleteSkill(workspaceRoot, forged, options),
          { ok: false, reason: 'not_found' },
          `forged ref ${forged} must not resolve`,
        );
      }
      await lstat(join(homeDir, '.agents', 'skills', 'user-helper', 'SKILL.md'));
    });
  });

  it('refuses to delete through a symlinked skill directory', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-skill-delete-outside-'));
      try {
        await mkdir(join(workspaceRoot, 'skills'), { recursive: true });
        await symlink(outside, join(workspaceRoot, 'skills', 'outside'));
        assert.deepEqual(await deleteSkill(workspaceRoot, 'outside'), { ok: false, reason: 'blocked_path' });
        // The symlink target survives — deletion never followed the link.
        await lstat(outside);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('does not trust mismatched or symlinked skill lock metadata', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'copied', `---
name: Copied
description: Exercise mismatched lock metadata.
---
# Copied`);
      await writeFile(join(workspaceRoot, 'skills', 'copied', 'skill.lock.json'), JSON.stringify({
        schemaVersion: 1,
        id: 'other-id',
        sourceType: 'bundled',
        sourceName: 'forged-bundle',
        sourceVersion: '1',
        contentSha256: `sha256:${sha256Hex(await readFile(join(workspaceRoot, 'skills', 'copied', 'SKILL.md'), 'utf8'))}`,
        installedAt: new Date(0).toISOString(),
      }), 'utf8');

      const outside = await mkdtemp(join(tmpdir(), 'maka-skill-lock-outside-'));
      try {
        await writeSkill(workspaceRoot, 'linked-lock', `---
name: Linked Lock
description: Exercise symlinked lock metadata.
---
# Linked Lock`);
        await writeFile(join(outside, 'skill.lock.json'), JSON.stringify({
          schemaVersion: 1,
          id: 'linked-lock',
          sourceType: 'bundled',
          sourceName: 'forged-bundle',
          sourceVersion: '1',
          contentSha256: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
          installedAt: new Date(0).toISOString(),
        }), 'utf8');
        await symlink(join(outside, 'skill.lock.json'), join(workspaceRoot, 'skills', 'linked-lock', 'skill.lock.json'));

        const skills = await listInstalledSkills(workspaceRoot);
        const copied = skills.find((skill) => skill.id === 'copied');
        const linked = skills.find((skill) => skill.id === 'linked-lock');
        assert.ok(copied);
        assert.equal(copied.sourceType, 'unknown');
        assert.equal(copied.sourceName, undefined);
        assert.equal(copied.validationStatus, 'metadata_error');
        assert.deepEqual(copied.validationCodes, ['id_mismatch']);
        assert.ok(linked);
        assert.equal(linked.sourceType, 'unknown');
        assert.equal(linked.validationStatus, 'metadata_error');
        assert.deepEqual(linked.validationCodes, ['lock_symlink']);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('does not trust forged bundled or managed skill lock metadata', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'deep-research', `---
name: Fake Deep Research
description: Exercise forged bundled metadata.
---
# Fake Deep Research
This is not the bundled template.`);
      const fakeBundledContent = await readFile(join(workspaceRoot, 'skills', 'deep-research', 'SKILL.md'), 'utf8');
      await writeFile(join(workspaceRoot, 'skills', 'deep-research', 'skill.lock.json'), JSON.stringify({
        schemaVersion: 1,
        id: 'deep-research',
        sourceType: 'bundled',
        sourceName: 'maka-bundled',
        sourceVersion: '1',
        contentSha256: `sha256:${sha256Hex(fakeBundledContent)}`,
        installedAt: new Date(0).toISOString(),
      }), 'utf8');

      await writeSkill(workspaceRoot, 'unknown-bundled', `---
name: Unknown Bundled
description: Exercise an invalid bundled skill id.
---
# Unknown Bundled`);
      const unknownBundledContent = await readFile(join(workspaceRoot, 'skills', 'unknown-bundled', 'SKILL.md'), 'utf8');
      await writeFile(join(workspaceRoot, 'skills', 'unknown-bundled', 'skill.lock.json'), JSON.stringify({
        schemaVersion: 1,
        id: 'unknown-bundled',
        sourceType: 'bundled',
        sourceName: 'maka-bundled',
        sourceVersion: '1',
        contentSha256: `sha256:${sha256Hex(unknownBundledContent)}`,
        installedAt: new Date(0).toISOString(),
      }), 'utf8');

      await writeSkill(workspaceRoot, 'managed-forgery', `---
name: Managed Forgery
description: Exercise forged managed metadata.
---
# Managed Forgery`);
      const managedContent = await readFile(join(workspaceRoot, 'skills', 'managed-forgery', 'SKILL.md'), 'utf8');
      await writeFile(join(workspaceRoot, 'skills', 'managed-forgery', 'skill.lock.json'), JSON.stringify({
        schemaVersion: 1,
        id: 'managed-forgery',
        sourceType: 'managed',
        sourceName: 'local-library',
        sourceVersion: '1',
        contentSha256: `sha256:${sha256Hex(managedContent)}`,
        installedAt: new Date(0).toISOString(),
      }), 'utf8');

      const skills = await listInstalledSkills(workspaceRoot);
      const fakeBundled = skills.find((skill) => skill.id === 'deep-research');
      const unknownBundled = skills.find((skill) => skill.id === 'unknown-bundled');
      const managed = skills.find((skill) => skill.id === 'managed-forgery');
      assert.ok(fakeBundled);
      assert.equal(fakeBundled.sourceType, 'unknown');
      assert.equal(fakeBundled.sourceName, undefined);
      assert.equal(fakeBundled.validationStatus, 'metadata_error');
      assert.deepEqual(fakeBundled.validationCodes, ['unsupported_schema']);
      assert.ok(unknownBundled);
      assert.equal(unknownBundled.sourceType, 'unknown');
      assert.equal(unknownBundled.sourceName, undefined);
      assert.equal(unknownBundled.validationStatus, 'metadata_error');
      assert.deepEqual(unknownBundled.validationCodes, ['unsupported_schema']);
      assert.ok(managed);
      assert.equal(managed.sourceType, 'unknown');
      assert.equal(managed.sourceName, undefined);
      assert.equal(managed.validationStatus, 'metadata_error');
      assert.deepEqual(managed.validationCodes, ['unsupported_schema']);
    });
  });

  it('does not trust forged managed locks that do not match the source snapshot', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const sourceRoot = await mkdtemp(join(tmpdir(), 'maka-managed-source-cache-'));
      try {
        const incomingDir = join(workspaceRoot, 'incoming', 'research-brief');
        await mkdir(incomingDir, { recursive: true });
        const incomingFile = join(incomingDir, 'SKILL.md');
        await writeFile(incomingFile, `---
name: Research Brief
description: Summarize research.
---
# Research Brief
Source snapshot.`, 'utf8');
        const imported = await importManagedSkillSource({ root: sourceRoot, sourceFile: incomingFile });
        assert.equal(imported.ok, true);
        if (!imported.ok) return;

        await writeSkill(workspaceRoot, 'research-brief', `---
name: Research Brief
description: Forged workspace copy.
---
# Research Brief
Forged workspace content.`);
        const forgedContent = await readFile(join(workspaceRoot, 'skills', 'research-brief', 'SKILL.md'), 'utf8');
        const forgedContentSha256 = `sha256:${sha256Hex(forgedContent)}`;
        assert.notEqual(forgedContentSha256, imported.source.contentSha256);
        await writeFile(join(workspaceRoot, 'skills', 'research-brief', 'skill.lock.json'), JSON.stringify({
          schemaVersion: 1,
          id: 'research-brief',
          sourceType: 'managed',
          sourceName: 'local-library',
          sourceVersion: '1',
          contentSha256: forgedContentSha256,
          installedAt: new Date(0).toISOString(),
          sourceId: 'research-brief',
          sourceContentSha256: imported.source.contentSha256,
        }), 'utf8');

        const skills = await listInstalledSkills(workspaceRoot, { managedSourceRoot: sourceRoot });
        const forged = skills.find((skill) => skill.id === 'research-brief');
        assert.ok(forged);
        assert.equal(forged.sourceType, 'unknown');
        assert.equal(forged.validationStatus, 'metadata_error');
        assert.deepEqual(forged.validationCodes, ['unsupported_schema']);
        assert.equal(forged.managedUpdateStatus, 'metadata_error');
        assert.deepEqual(await updateManagedSkill(workspaceRoot, 'research-brief', sourceRoot), {
          ok: false,
          reason: 'metadata_error',
        });
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it('updates managed skills only when the workspace copy is clean', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const sourceRoot = await mkdtemp(join(tmpdir(), 'maka-managed-source-cache-'));
      try {
        const incomingDir = join(workspaceRoot, 'incoming', 'deck-helper');
        await mkdir(incomingDir, { recursive: true });
        const incomingFile = join(incomingDir, 'SKILL.md');
        await writeFile(incomingFile, `---
name: Deck Helper
description: Build decks.
---
# Deck Helper
Version one.`, 'utf8');
        const imported = await importManagedSkillSource({ root: sourceRoot, sourceFile: incomingFile });
        assert.equal(imported.ok, true);
        if (!imported.ok) return;
        const installed = await installManagedSkill(workspaceRoot, imported.source.id, sourceRoot);
        assert.equal(installed.ok, true);

        await writeFile(join(sourceRoot, 'deck-helper', 'SKILL.md'), `---
name: Deck Helper
description: Build decks.
---
# Deck Helper
Version two.`, 'utf8');

        const cleanPreview = await previewManagedSkillUpdate(workspaceRoot, 'deck-helper', sourceRoot);
        assert.equal(cleanPreview.ok, true);
        if (!cleanPreview.ok) return;
        await writeFile(join(sourceRoot, 'deck-helper', 'SKILL.md'), `---
name: Deck Helper
description: Build decks.
---
# Deck Helper
Version two changed after preview.`, 'utf8');
        assert.deepEqual(await updateManagedSkill(workspaceRoot, 'deck-helper', sourceRoot, {
          expectedCurrentSha256: cleanPreview.preview.expectedCurrentSha256,
          expectedSourceSha256: cleanPreview.preview.expectedSourceSha256,
        }), {
          ok: false,
          reason: 'local_modified',
        });
        assert.match(await readFile(join(workspaceRoot, 'skills', 'deck-helper', 'SKILL.md'), 'utf8'), /Version one\./);

        const freshCleanPreview = await previewManagedSkillUpdate(workspaceRoot, 'deck-helper', sourceRoot);
        assert.equal(freshCleanPreview.ok, true);
        if (!freshCleanPreview.ok) return;
        const updated = await updateManagedSkill(workspaceRoot, 'deck-helper', sourceRoot, {
          expectedCurrentSha256: freshCleanPreview.preview.expectedCurrentSha256,
          expectedSourceSha256: freshCleanPreview.preview.expectedSourceSha256,
        });
        assert.equal(updated.ok, true);
        if (!updated.ok) return;
        assert.equal(updated.skill.managedUpdateStatus, 'up_to_date');
        assert.match(await readFile(join(workspaceRoot, 'skills', 'deck-helper', 'SKILL.md'), 'utf8'), /Version two changed after preview\./);
        assert.match(await readFile(join(workspaceRoot, 'skills', 'deck-helper', '.maka', 'baseline', 'SKILL.md'), 'utf8'), /Version two changed after preview\./);

        await writeFile(join(sourceRoot, 'deck-helper', 'SKILL.md'), `---
name: Deck Helper
description: Build decks.
---
# Deck Helper
Version three.`, 'utf8');
        await writeFile(join(workspaceRoot, 'skills', 'deck-helper', 'SKILL.md'), `---
name: Deck Helper
description: Build decks.
---
# Deck Helper
Local edit.`, 'utf8');

        const blocked = await updateManagedSkill(workspaceRoot, 'deck-helper', sourceRoot);
        assert.deepEqual(blocked, { ok: false, reason: 'local_modified' });

        const preview = await previewManagedSkillUpdate(workspaceRoot, 'deck-helper', sourceRoot);
        assert.equal(preview.ok, true);
        if (!preview.ok) return;
        assert.match(preview.preview.currentContent, /Local edit\./);
        assert.match(preview.preview.sourceContent, /Version three\./);
        assert.match(preview.preview.baselineContent ?? '', /Version two changed after preview\./);
        assert.equal(preview.preview.skill.managedUpdateStatus, 'local_modified');
        assert.ok(preview.preview.summary.changedLineCount > 0);

        assert.deepEqual(await updateManagedSkill(workspaceRoot, 'deck-helper', sourceRoot, { force: true }), {
          ok: false,
          reason: 'local_modified',
        });
        await writeFile(join(workspaceRoot, 'skills', 'deck-helper', 'SKILL.md'), `---
name: Deck Helper
description: Build decks.
---
# Deck Helper
Changed after preview.`, 'utf8');
        assert.deepEqual(await updateManagedSkill(workspaceRoot, 'deck-helper', sourceRoot, {
          force: true,
          expectedCurrentSha256: preview.preview.expectedCurrentSha256,
          expectedSourceSha256: preview.preview.expectedSourceSha256,
        }), {
          ok: false,
          reason: 'local_modified',
        });

        const freshPreview = await previewManagedSkillUpdate(workspaceRoot, 'deck-helper', sourceRoot);
        assert.equal(freshPreview.ok, true);
        if (!freshPreview.ok) return;
        const forced = await updateManagedSkill(workspaceRoot, 'deck-helper', sourceRoot, {
          force: true,
          expectedCurrentSha256: freshPreview.preview.expectedCurrentSha256,
          expectedSourceSha256: freshPreview.preview.expectedSourceSha256,
        });
        assert.equal(forced.ok, true);
        if (!forced.ok) return;
        assert.match(await readFile(join(workspaceRoot, 'skills', 'deck-helper', 'SKILL.md'), 'utf8'), /Version three\./);
        assert.match(await readFile(join(workspaceRoot, 'skills', 'deck-helper', '.maka', 'baseline', 'SKILL.md'), 'utf8'), /Version three\./);

        const skills = await listInstalledSkills(workspaceRoot, { managedSourceRoot: sourceRoot });
        const managed = skills.find((skill) => skill.id === 'deck-helper');
        assert.ok(managed);
        assert.equal(managed.managedUpdateStatus, 'up_to_date');
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  it('does not write managed skill baselines through symlinks', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const sourceRoot = await mkdtemp(join(tmpdir(), 'maka-managed-source-cache-'));
      const outside = await mkdtemp(join(tmpdir(), 'maka-managed-baseline-outside-'));
      try {
        const incomingDir = join(workspaceRoot, 'incoming', 'deck-helper');
        await mkdir(incomingDir, { recursive: true });
        const incomingFile = join(incomingDir, 'SKILL.md');
        await writeFile(incomingFile, `---
name: Deck Helper
description: Build decks.
---
# Deck Helper
Version one.`, 'utf8');
        const imported = await importManagedSkillSource({ root: sourceRoot, sourceFile: incomingFile });
        assert.equal(imported.ok, true);
        if (!imported.ok) return;
        const installed = await installManagedSkill(workspaceRoot, imported.source.id, sourceRoot);
        assert.equal(installed.ok, true);

        const externalBaseline = join(outside, 'SKILL.md');
        await writeFile(externalBaseline, 'outside baseline', 'utf8');
        const baselinePath = join(workspaceRoot, 'skills', 'deck-helper', '.maka', 'baseline', 'SKILL.md');
        await rm(baselinePath);
        await symlink(externalBaseline, baselinePath);

        await writeFile(join(sourceRoot, 'deck-helper', 'SKILL.md'), `---
name: Deck Helper
description: Build decks.
---
# Deck Helper
Version two.`, 'utf8');
        const updated = await updateManagedSkill(workspaceRoot, 'deck-helper', sourceRoot);
        assert.deepEqual(updated, { ok: false, reason: 'write_failed' });
        assert.equal(await readFile(externalBaseline, 'utf8'), 'outside baseline');
        const baselineStat = await lstat(baselinePath);
        assert.equal(baselineStat.isSymbolicLink(), true);
        assert.match(await readFile(join(workspaceRoot, 'skills', 'deck-helper', 'SKILL.md'), 'utf8'), /Version one\./);
        const skills = await listInstalledSkills(workspaceRoot, { managedSourceRoot: sourceRoot });
        assert.equal(skills.find((skill) => skill.id === 'deck-helper')?.managedUpdateStatus, 'update_available');
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('does not write managed skill updates through symlinked SKILL files', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const sourceRoot = await mkdtemp(join(tmpdir(), 'maka-managed-source-cache-'));
      const outside = await mkdtemp(join(tmpdir(), 'maka-managed-skill-outside-'));
      try {
        const incomingDir = join(workspaceRoot, 'incoming', 'deck-helper');
        await mkdir(incomingDir, { recursive: true });
        const incomingFile = join(incomingDir, 'SKILL.md');
        await writeFile(incomingFile, `---
name: Deck Helper
description: Build decks.
---
# Deck Helper
Version one.`, 'utf8');
        const imported = await importManagedSkillSource({ root: sourceRoot, sourceFile: incomingFile });
        assert.equal(imported.ok, true);
        if (!imported.ok) return;
        const installed = await installManagedSkill(workspaceRoot, imported.source.id, sourceRoot);
        assert.equal(installed.ok, true);

        const externalSkillContent = `---
name: Deck Helper
description: Build decks.
---
# Deck Helper
Version one.`;
        const externalSkill = join(outside, 'SKILL.md');
        await writeFile(externalSkill, externalSkillContent, 'utf8');
        const skillPath = join(workspaceRoot, 'skills', 'deck-helper', 'SKILL.md');
        await rm(skillPath);
        await symlink(externalSkill, skillPath);
        await writeFile(join(sourceRoot, 'deck-helper', 'SKILL.md'), `---
name: Deck Helper
description: Build decks.
---
# Deck Helper
Version two.`, 'utf8');

        assert.deepEqual(await updateManagedSkill(workspaceRoot, 'deck-helper', sourceRoot), {
          ok: false,
          reason: 'blocked_path',
        });
        const preview = await previewManagedSkillUpdate(workspaceRoot, 'deck-helper', sourceRoot);
        assert.deepEqual(preview, { ok: false, reason: 'blocked_path' });
        assert.equal(await readFile(externalSkill, 'utf8'), externalSkillContent);
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('does not read managed skill baselines through symlinked metadata directories', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const sourceRoot = await mkdtemp(join(tmpdir(), 'maka-managed-source-cache-'));
      const outside = await mkdtemp(join(tmpdir(), 'maka-managed-baseline-parent-outside-'));
      try {
        const incomingDir = join(workspaceRoot, 'incoming', 'deck-helper');
        await mkdir(incomingDir, { recursive: true });
        const incomingFile = join(incomingDir, 'SKILL.md');
        await writeFile(incomingFile, `---
name: Deck Helper
description: Build decks.
---
# Deck Helper
Version one.`, 'utf8');
        const imported = await importManagedSkillSource({ root: sourceRoot, sourceFile: incomingFile });
        assert.equal(imported.ok, true);
        if (!imported.ok) return;
        const installed = await installManagedSkill(workspaceRoot, imported.source.id, sourceRoot);
        assert.equal(installed.ok, true);

        await mkdir(join(outside, 'baseline'), { recursive: true });
        await writeFile(join(outside, 'baseline', 'SKILL.md'), 'outside baseline', 'utf8');
        const metadataDir = join(workspaceRoot, 'skills', 'deck-helper', '.maka');
        await rm(metadataDir, { recursive: true, force: true });
        await symlink(outside, metadataDir);

        await writeFile(join(sourceRoot, 'deck-helper', 'SKILL.md'), `---
name: Deck Helper
description: Build decks.
---
# Deck Helper
Version two.`, 'utf8');
        const preview = await previewManagedSkillUpdate(workspaceRoot, 'deck-helper', sourceRoot);
        assert.equal(preview.ok, true);
        if (!preview.ok) return;
        assert.equal(preview.preview.baselineContent, undefined);
        assert.deepEqual(await updateManagedSkill(workspaceRoot, 'deck-helper', sourceRoot), {
          ok: false,
          reason: 'write_failed',
        });
        assert.equal(await readFile(join(outside, 'baseline', 'SKILL.md'), 'utf8'), 'outside baseline');
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('rejects a symlinked skills directory instead of writing through it', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-skills-outside-'));
      try {
        await mkdir(join(outside, 'external'), { recursive: true });
        await writeFile(join(outside, 'external', 'SKILL.md'), `---
name: External
description: Exercise a symlinked skills directory.
---
# External`, 'utf8');
        await symlink(outside, join(workspaceRoot, 'skills'));
        assert.deepEqual(await createStarterSkill(workspaceRoot), { ok: false, reason: 'blocked_path' });
        assert.deepEqual(await listInstalledSkills(workspaceRoot), []);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('resolves only workspace-contained skill files for opening', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'writer', `---
name: Writer
description: Exercise workspace-contained open paths.
---
# Writer`);
      const skillFile = await realpath(join(workspaceRoot, 'skills', 'writer', 'SKILL.md'));
      const skillDirectory = await realpath(join(workspaceRoot, 'skills', 'writer'));
      assert.deepEqual(
        await resolveSkillOpenPath(workspaceRoot, 'writer', 'file'),
        { ok: true, path: skillFile, target: 'file' },
      );
      assert.deepEqual(
        await resolveSkillOpenPath(workspaceRoot, 'writer', 'directory'),
        { ok: true, path: skillDirectory, target: 'directory' },
      );
      assert.deepEqual(await resolveSkillOpenPath(workspaceRoot, '../writer', 'file'), {
        ok: false,
        reason: 'invalid_id',
      });
    });
  });

  it('blocks symlinked skill directories when opening a specific skill', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-skill-open-outside-'));
      try {
        await mkdir(join(workspaceRoot, 'skills'), { recursive: true });
        await symlink(outside, join(workspaceRoot, 'skills', 'outside'));
        assert.deepEqual(await resolveSkillOpenPath(workspaceRoot, 'outside', 'directory'), {
          ok: false,
          reason: 'blocked_path',
        });
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });


});

async function withWorkspace(fn: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-skills-'));
  try {
    await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function writeSkill(workspaceRoot: string, id: string, content: string): Promise<void> {
  const dir = join(workspaceRoot, 'skills', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), content, 'utf8');
}

async function writeSkillAt(
  skillsDir: string,
  id: string,
  name: string,
  description: string,
): Promise<void> {
  const dir = join(skillsDir, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}`,
    'utf8',
  );
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
