import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';
import {
  MAX_SKILLS_PROMPT_CHARS,
  MAX_SKILL_TOOL_BODY_CHARS,
  buildSkillAgentTool,
  buildSkillsPromptFragment,
  createStarterSkill,
  deleteSkill,
  getSkillGovernanceDetails,
  installManagedSkill,
  loadSkillInstructions,
  listGovernedSkillEntries,
  listInstalledSkills,
  parseSkillFrontMatter,
  previewManagedSkillUpdate,
  resolveSkillOpenPath,
  setSkillEnabled,
  setSkillPinned,
  updateManagedSkill,
} from '../skills.js';
import { importManagedSkillSource } from '../managed-skill-sources.js';
import { createSystemPromptMainService } from '../system-prompt-main.js';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';
import { extractFunctionBlock } from './function-block-helpers.js';

describe('skills ingestion', () => {
  it('lists SKILL.md metadata without granting declared tools', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'writer', `---
name: Writer
description: Draft polished prose.
allowed-tools: [Read, Write]
---
# Writer
Use concise prose.`);

      const skills = await listInstalledSkills(workspaceRoot);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].id, 'writer');
      assert.equal(skills[0].name, 'Writer');
      assert.equal(skills[0].description, 'Draft polished prose.');
      assert.deepEqual(skills[0].declaredTools, ['Read', 'Write']);
      assert.equal(skills[0].sourceType, 'workspace');
      assert.equal(skills[0].userModified, false);
      assert.equal(skills[0].validationStatus, 'missing_lock');
      assert.deepEqual(skills[0].validationCodes, ['missing_lock']);
    });
  });

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

  it('shares one Desktop host capability surface between the prompt and Skill tool', async () => {
    const mainProcess = await readMainProcessCombinedSource();
    assert.match(mainProcess, /const desktopProductToolSurface = projectEffectiveProductToolSurface\(\{/);
    assert.match(mainProcess, /hostCapabilities: desktopProductToolSurface\.hostCapabilities/);
    assert.match(mainProcess, /buildSkillsPromptFragmentWithReport\(\s*skillSource,\s*options\?\.host \?\? deps\.host \?\? deps\.hostCapabilities,\s*options\?\.skillBudget,\s*\)/);
    assert.match(mainProcess, /getSkillSelectionReport: systemPromptService\.getLastSkillSelectionReport/);
    assert.match(mainProcess, /buildSkillAgentTool\([\s\S]*resolveDesktopSkillHost,[\s\S]*shadowTracker/);
    assert.match(mainProcess, /buildSkillSearchAgentTool\([\s\S]*resolveDesktopSkillHost,[\s\S]*shadowTracker/);
    assert.match(mainProcess, /const productToolSurface = projectEffectiveProductToolSurface\(\{/);
    assert.doesNotMatch(mainProcess, /const backendCapabilities = new Set<string>\(\)/);
    assert.match(mainProcess, /\.\.\.deps\.builtinTools,[\s\S]*\.\.\.buildMcpTools\(deps\.mcpManager\)/);
    assert.match(mainProcess, /const backendTools = computerUseToolsForModel\(/);
    assert.doesNotMatch(mainProcess, /const backendToolNames = new Set\(/);
    assert.match(mainProcess, /skillHost: productToolSurface\.hostCapabilities/);
    assert.match(mainProcess, /if \(!ctx\.tools\) desktopSessionSkillHosts\.set\(ctx\.sessionId, backendSkillHost\)/);
    assert.match(mainProcess, /host: backendSkillHost/);
  });

  it('caches the exact prompt selection report for the Desktop Context Inspector', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'writer', `---
name: Writer
description: Draft project prose.
---
# Writer`);
      const service = createSystemPromptMainService({
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
        host: { toolNames: new Set() },
      });

      await service.buildBackendSystemPrompt(
        { labels: [] },
        workspaceRoot,
        { memoryFragment: null, skillBudget: { contextWindow: 128_000 } },
      );
      const report = service.getLastSkillSelectionReport(workspaceRoot);
      assert.ok(report);
      assert.equal(
        report.decisions.find((decision) => decision.id === 'writer')?.reason,
        'advertised',
      );
      service.invalidateSkillSelectionReport(workspaceRoot);
      assert.equal(service.getLastSkillSelectionReport(workspaceRoot), undefined);
    });
  });

  it('lists available skills in the system prompt and loads instructions lazily', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'browser-helper', `---
name: Browser Helper
description: Use when the user asks for browser automation.
allowed-tools:
  - Bash
  - Read
---
# Browser Helper
Open local targets carefully.
Do not ask permission for shell commands.`);

      const prompt = await buildSkillsPromptFragment(workspaceRoot);
      assert.ok(prompt);
      assert.match(prompt, /Available local skills/);
      assert.match(prompt, /call the Skill tool/);
      assert.match(prompt, /active session sandbox boundary remains authoritative/);
      assert.match(prompt, /<available-skill id="browser-helper" name="Browser Helper">/);
      assert.match(prompt, /Description: Use when the user asks for browser automation\./);
      assert.match(prompt, /Declared tools: Bash, Read/);
      assert.doesNotMatch(prompt, /Open local targets carefully\./);
      assert.doesNotMatch(prompt, /Do not ask permission for shell commands\./);
      assert.ok(prompt.length <= MAX_SKILLS_PROMPT_CHARS + 512);

      const loaded = await loadSkillInstructions(workspaceRoot, 'browser-helper');
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;
      assert.equal(loaded.skill.id, 'browser-helper');
      assert.equal(loaded.skill.name, 'Browser Helper');
      assert.deepEqual(loaded.skill.declaredTools, ['Bash', 'Read']);
      assert.equal(loaded.skill.relativePath, 'skills/browser-helper/SKILL.md');
      assert.match(loaded.skill.instructions, /Open local targets carefully\./);
      assert.match(loaded.skill.instructions, /Do not ask permission for shell commands\./);
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

  it('marks ambiguous v1 ids for review instead of guessing a scope during migration', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const projectRoot = join(workspaceRoot, 'project');
      const homeDir = join(workspaceRoot, 'home');
      await mkdir(projectRoot, { recursive: true });
      await mkdir(homeDir, { recursive: true });
      await writeSkillAt(
        join(projectRoot, '.maka', 'skills'),
        'shared',
        'Project Shared',
        'Project copy.',
      );
      await writeSkillAt(
        join(homeDir, '.agents', 'skills'),
        'shared',
        'User Shared',
        'User copy.',
      );
      await mkdir(join(workspaceRoot, '.maka'), { recursive: true });
      await writeFile(
        join(workspaceRoot, '.maka', 'skills-state.json'),
        JSON.stringify({ schemaVersion: 1, skills: { shared: { enabled: false } } }),
        'utf8',
      );
      const options = { cwd: projectRoot, homeDir };

      const pending = await listGovernedSkillEntries(workspaceRoot, options);
      assert.ok(
        pending.filter((skill) => skill.id === 'shared').every((skill) => skill.needsReview),
      );
      assert.deepEqual(await setSkillPinned(workspaceRoot, 'shared', true, options), {
        ok: false,
        reason: 'needs_review',
      });
      const projectPinned = await setSkillPinned(
        workspaceRoot,
        'project:maka:shared',
        true,
        options,
      );
      assert.equal(projectPinned.ok, true);
      const interim = JSON.parse(
        await readFile(join(workspaceRoot, '.maka', 'skills-state.json'), 'utf8'),
      ) as {
        skills: Record<string, { enabled: boolean; pinned: boolean }>;
        migration?: { needsReview: string[] };
      };
      assert.deepEqual(interim.migration?.needsReview, ['shared']);
      assert.equal(interim.skills.shared?.enabled, false);
      assert.equal(interim.skills['project:maka:shared']?.pinned, true);

      const userReviewed = await setSkillPinned(
        workspaceRoot,
        'user:agents:shared',
        false,
        options,
      );
      assert.equal(userReviewed.ok, true);
      const migrated = JSON.parse(
        await readFile(join(workspaceRoot, '.maka', 'skills-state.json'), 'utf8'),
      ) as {
        skills: Record<string, { enabled: boolean; pinned: boolean }>;
        migration?: { needsReview: string[] };
      };
      assert.equal(migrated.migration, undefined);
      assert.equal(migrated.skills.shared, undefined);
      assert.equal(migrated.skills['project:maka:shared']?.enabled, false);
      assert.equal(migrated.skills['user:agents:shared']?.enabled, false);
      const reviewed = await listGovernedSkillEntries(workspaceRoot, options);
      assert.ok(
        reviewed.filter((skill) => skill.id === 'shared').every((skill) => !skill.needsReview),
      );
    });
  });

  it('projects case-only v1 duplicates from one normalized legacy preference', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const projectRoot = join(workspaceRoot, 'project');
      const homeDir = join(workspaceRoot, 'home');
      await mkdir(projectRoot, { recursive: true });
      await mkdir(homeDir, { recursive: true });
      await writeSkillAt(
        join(projectRoot, '.maka', 'skills'),
        'shared',
        'Project Shared',
        'Project copy.',
      );
      await writeSkillAt(
        join(homeDir, '.agents', 'skills'),
        'Shared',
        'User Shared',
        'User copy.',
      );
      await mkdir(join(workspaceRoot, '.maka'), { recursive: true });
      await writeFile(
        join(workspaceRoot, '.maka', 'skills-state.json'),
        JSON.stringify({ schemaVersion: 1, skills: { Shared: { enabled: false } } }),
        'utf8',
      );

      const entries = (
        await listGovernedSkillEntries(workspaceRoot, {
          cwd: projectRoot,
          homeDir,
        })
      ).filter((skill) => skill.id.toLowerCase() === 'shared');
      assert.equal(entries.length, 2);
      for (const entry of entries) {
        assert.equal(entry.enabled, false);
        assert.equal(entry.pinned, false);
        assert.equal(entry.runtimeStatus, 'disabled');
        assert.equal(entry.needsReview, true);
      }
      assert.equal(
        entries.find((entry) => entry.scope === 'project')?.contextStatus,
        'disabled',
      );
      assert.equal(
        entries.find((entry) => entry.scope === 'user')?.contextStatus,
        'shadowed',
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

  it('loads an enabled duplicate-name skill before reporting a disabled duplicate as blocked', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'disabled-copy', `---
name: Shared Helper
description: Disabled duplicate.
---
# Shared Helper
Disabled copy.`);
      await writeSkill(workspaceRoot, 'enabled-copy', `---
name: Shared Helper
description: Enabled duplicate.
---
# Shared Helper
Enabled copy.`);

      const disabled = await setSkillEnabled(workspaceRoot, 'disabled-copy', false);
      assert.equal(disabled.ok, true);

      const loadedByName = await loadSkillInstructions(workspaceRoot, 'Shared Helper');
      assert.equal(loadedByName.ok, true);
      if (!loadedByName.ok) return;
      assert.equal(loadedByName.skill.id, 'enabled-copy');
      assert.match(loadedByName.skill.instructions, /Enabled copy\./);

      const loadedDisabledById = await loadSkillInstructions(workspaceRoot, 'disabled-copy');
      assert.equal(loadedDisabledById.ok, false);
      if (loadedDisabledById.ok) return;
      assert.equal(loadedDisabledById.reason, 'disabled');
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

  it('exposes a read-only Skill tool that loads a single matching local skill', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'deck-helper', `---
name: Deck Helper
description: Build a slide outline.
allowed-tools: [Read, Bash]
---
# Deck Helper
Make every slide carry one idea.`);

      const tool = buildSkillAgentTool(workspaceRoot);
      assert.equal(tool.name, 'Skill');
      const result = await tool.impl({ name: 'Deck Helper' }, {
        sessionId: 's1',
        turnId: 't1',
        cwd: workspaceRoot,
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.skill.id, 'deck-helper');
      assert.match(result.skill.instructions, /Make every slide carry one idea\./);
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

  it('returns undefined when no skills directory exists', async () => {
    await withWorkspace(async (workspaceRoot) => {
      assert.deepEqual(await listInstalledSkills(workspaceRoot), []);
      assert.equal(await buildSkillsPromptFragment(workspaceRoot), undefined);
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

  it('reuses an existing starter skill instead of minting a duplicate', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'starter-skill', `---
name: Existing
description: Preserve an existing starter skill.
---
# Existing`);

      const result = await createStarterSkill(workspaceRoot);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      // The existing starter-skill/SKILL.md is reused verbatim; no starter-skill-2
      // is created and the user's content is left untouched.
      assert.equal(result.created, false);
      assert.equal(result.skill.id, 'starter-skill');
      assert.match(await readFile(join(workspaceRoot, 'skills', 'starter-skill', 'SKILL.md'), 'utf8'), /# Existing/);
      await assert.rejects(lstat(join(workspaceRoot, 'skills', 'starter-skill-2')), { code: 'ENOENT' });
    });
  });

  it('deletes an installed skill directory', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'starter-skill', `---
name: 示例技能
description: 用于测试删除已安装技能。
---
# 示例技能`);
      assert.equal((await listInstalledSkills(workspaceRoot)).length, 1);

      assert.deepEqual(await deleteSkill(workspaceRoot, 'starter-skill'), { ok: true });
      assert.equal((await listInstalledSkills(workspaceRoot)).length, 0);
      await assert.rejects(lstat(join(workspaceRoot, 'skills', 'starter-skill')), { code: 'ENOENT' });

      // Deleting an absent skill is a clean not_found, not a throw.
      assert.deepEqual(await deleteSkill(workspaceRoot, 'starter-skill'), { ok: false, reason: 'not_found' });
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

  it('treats invalid skill locks as status metadata without changing runtime behavior', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(workspaceRoot, 'broken-lock', `---
name: Broken Lock
description: Still usable.
allowed-tools: [Read]
---
# Broken Lock
Load me anyway.`);
      await writeFile(join(workspaceRoot, 'skills', 'broken-lock', 'skill.lock.json'), '{not json', 'utf8');

      const skills = await listInstalledSkills(workspaceRoot);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].id, 'broken-lock');
      assert.equal(skills[0].sourceType, 'unknown');
      assert.equal(skills[0].userModified, false);
      assert.equal(skills[0].validationStatus, 'metadata_error');
      assert.deepEqual(skills[0].validationCodes, ['invalid_json']);

      const prompt = await buildSkillsPromptFragment(workspaceRoot);
      assert.ok(prompt);
      assert.match(prompt, /<available-skill id="broken-lock" name="Broken Lock">/);
      assert.doesNotMatch(prompt, /skill\.lock\.json/);
      assert.doesNotMatch(prompt, /sourceType/);
      assert.doesNotMatch(prompt, /contentSha256/);
      assert.doesNotMatch(prompt, /sourceVersion/);

      const loaded = await loadSkillInstructions(workspaceRoot, 'broken-lock');
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;
      assert.match(loaded.skill.instructions, /Load me anyway\./);
      assert.doesNotMatch(JSON.stringify(loaded.skill), /skill\.lock\.json|sourceType|contentSha256|sourceVersion/);
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

  it('installs managed sources into the workspace without using the source cache at runtime', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const sourceRoot = await mkdtemp(join(tmpdir(), 'maka-managed-source-cache-'));
      try {
        const incomingDir = join(workspaceRoot, 'incoming', 'research-brief');
        await mkdir(incomingDir, { recursive: true });
        const incomingFile = join(incomingDir, 'SKILL.md');
        await writeFile(incomingFile, `---
name: Research Brief
description: Summarize research.
allowed-tools: [Read]
---
# Research Brief
Use source version one.`, 'utf8');

        const imported = await importManagedSkillSource({ root: sourceRoot, sourceFile: incomingFile });
        assert.equal(imported.ok, true);
        if (!imported.ok) return;

        const installed = await installManagedSkill(workspaceRoot, imported.source.id, sourceRoot);
        assert.equal(installed.ok, true);
        if (!installed.ok) return;
        assert.equal(installed.skill.id, 'research-brief');
        assert.equal(installed.skill.sourceType, 'managed');
        assert.equal(installed.skill.sourceName, 'local-library');
        assert.equal(installed.skill.managedSourceId, 'research-brief');
        assert.equal(installed.skill.managedUpdateStatus, 'up_to_date');

        const lock = JSON.parse(await readFile(join(workspaceRoot, 'skills', 'research-brief', 'skill.lock.json'), 'utf8')) as Record<string, unknown>;
        assert.equal(lock.sourceType, 'managed');
        assert.equal(lock.sourceId, 'research-brief');
        assert.equal(lock.sourceContentSha256, imported.source.contentSha256);
        assert.match(await readFile(join(workspaceRoot, 'skills', 'research-brief', '.maka', 'baseline', 'SKILL.md'), 'utf8'), /Use source version one\./);

        await writeFile(join(sourceRoot, 'research-brief', 'SKILL.md'), `---
name: Research Brief
description: Summarize research.
allowed-tools: [Read]
---
# Research Brief
Use source version two.`, 'utf8');

        const loaded = await loadSkillInstructions(workspaceRoot, 'research-brief');
        assert.equal(loaded.ok, true);
        if (!loaded.ok) return;
        assert.match(loaded.skill.instructions, /Use source version one\./);
        assert.doesNotMatch(loaded.skill.instructions, /Use source version two\./);

        const skills = await listInstalledSkills(workspaceRoot, { managedSourceRoot: sourceRoot });
        const managed = skills.find((skill) => skill.id === 'research-brief');
        assert.ok(managed);
        assert.equal(managed.managedUpdateStatus, 'update_available');

        const details = await getSkillGovernanceDetails(workspaceRoot, 'research-brief', sourceRoot);
        assert.equal(details.ok, true);
        if (!details.ok) return;
        assert.equal(details.details.sourceType, 'managed');
        assert.equal(details.details.hasManagedBaseline, true);
        assert.equal(details.details.sourceAvailable, true);
        assert.equal(details.details.sourceChanged, true);
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

  it('skills empty state can refresh without restarting Maka', async () => {
    const repoRoot = process.cwd().endsWith('apps/desktop')
      ? join(process.cwd(), '..', '..')
      : process.cwd();
    const ui = await readFile(join(repoRoot, 'packages/ui/src/skills-panel.tsx'), 'utf8');
    const renderer = await readRendererShellCombinedSource();
    const preload = await readFile(join(repoRoot, 'apps/desktop/src/preload/preload.ts'), 'utf8');
    const main = await readMainProcessCombinedSource();

    assert.match(ui, /onRefreshSkills\?\(\): void \| Promise<void>/);
    assert.match(ui, /onCreateSkillTemplate\?\(\): void \| Promise<void>/);
    assert.match(ui, /onOpenSkillsFolder\?\(\): void \| Promise<void>/);
    assert.match(ui, /copy\.installed\.createExample/);
    assert.match(ui, /copy\.installed\.refresh/);
    assert.match(ui, /copy\.page\.creating/);
    assert.match(ui, /copy\.page\.refreshing/);
    assert.match(ui, /copy\.page\.openFolder/);
    // The inert 技能示例 example cards were removed — 添加 seeds a real,
    // editable starter skill instead. No decorative example rows may return.
    assert.doesNotMatch(ui, /title: '文档处理流'/);
    assert.doesNotMatch(ui, /title: '演示资料流'/);
    assert.doesNotMatch(ui, /SKILL_EXAMPLE_CARDS/);
    assert.doesNotMatch(ui, /重启 Maka 后会出现在这里/);
    assert.match(renderer, /async function refreshSkills\(options: \{ shouldShowError\?: \(\) => boolean \} = \{\}\)/);
    assert.match(renderer, /async function createSkillTemplate\(\)/);
    assert.match(renderer, /onRefreshSkills=\{\(\) => refreshSkills\(\)\}/);
    assert.match(renderer, /onCreateSkillTemplate=\{\(\) => createSkillTemplate\(\)\}/);
    assert.match(renderer, /onOpenSkill=\{\(skillId\) => openSkill\(skillId\)\}/);
    assert.match(renderer, /onOpenSkillsFolder=\{\(\) => openSkillsFolder\(\)\}/);
    assert.match(renderer, /onPreviewManagedSkillUpdate=\{\(skillId\) => previewManagedSkillUpdate\(skillId\)\}/);
    assert.match(renderer, /onUpdateManagedSkill=\{\(skillId, options\) => updateManagedSkill\(skillId, options\)\}/);
    assert.match(renderer, /onSetSkillEnabled=\{\(skillId, enabled\) => setSkillEnabled\(skillId, enabled\)\}/);
    assert.match(renderer, /onSetSkillPinned=\{\(skillRef, pinned\) => setSkillPinned\(skillRef, pinned\)\}/);
    assert.match(renderer, /onDeleteSkill=\{\(skillRef\) => deleteSkill\(skillRef\)\}/);
    assert.match(preload, /createStarter\(\)/);
    assert.match(preload, /delete\(idOrRef: string\)/);
    assert.match(preload, /open\(id: string, target: 'file' \| 'directory' = 'file'\)/);
    assert.match(preload, /previewUpdate\(skillId: string\)/);
    assert.match(preload, /updateManaged\(skillId: string, options\?: \{ force\?: boolean; expectedCurrentSha256\?: string; expectedSourceSha256\?: string \}\)/);
    assert.match(preload, /setEnabled\(skillId: string, enabled: boolean\)/);
    assert.match(preload, /setPinned\(skillRef: string, pinned: boolean\)/);
    assert.match(main, /ipcMain\.handle\('skills:createStarter'/);
    assert.match(main, /ipcMain\.handle\('skills:delete'/);
    assert.match(main, /ipcMain\.handle\('skills:open'/);
    assert.match(main, /ipcMain\.handle\('skills:details'/);
    assert.match(main, /ipcMain\.handle\('skills:previewUpdate'/);
    assert.match(main, /ipcMain\.handle\('skills:setEnabled'/);
    assert.match(main, /ipcMain\.handle\('skills:setPinned'/);
  });

  it('gates Skills module actions while async work is pending', async () => {
    const repoRoot = process.cwd().endsWith('apps/desktop')
      ? join(process.cwd(), '..', '..')
      : process.cwd();
    const modulePagesSource = await readFile(join(repoRoot, 'packages/ui/src/module-pages.tsx'), 'utf8');
    const ui = await readFile(join(repoRoot, 'packages/ui/src/skills-panel.tsx'), 'utf8');
    const modulePanelTypes = await readFile(join(repoRoot, 'packages/ui/src/module-panel-types.ts'), 'utf8');
    const workspaceResourcesIpc = await readFile(join(repoRoot, 'apps/desktop/src/main/workspace-resources-ipc-main.ts'), 'utf8');
    const renderer = await readRendererShellCombinedSource();
    const skillsModuleMain = extractFunctionBlock(ui, 'SkillsModuleMain');
    const skillPanel = ui.match(/function SkillLibraryPanel[\s\S]*?function SkillsModuleMain/)?.[0] ?? '';
    const skillEntryContract = modulePanelTypes.match(/export interface SkillEntry[\s\S]*?\n}/)?.[0] ?? '';

    assert.match(modulePagesSource, /export function SkillsPage[\s\S]*<SkillsModuleMain/, 'SkillsPage must mount the skills main surface');
    assert.match(skillsModuleMain, /const \[pendingSkillAction, setPendingSkillAction\] = useState<string \| null>\(null\)/);
    assert.match(skillsModuleMain, /const skillActionMountedRef = useMountedRef\(\)/);
    assert.match(skillsModuleMain, /const pendingSkillActionRef = useRef<string \| null>\(null\)/);
    assert.match(
      skillsModuleMain,
      /useEffect\(\(\) => \{\s*return \(\) => \{\s*pendingSkillActionRef\.current = null;\s*\};\s*\}, \[\]\)/,
      'Skills actions must release pending ownership when the module unmounts',
    );
    assert.match(skillsModuleMain, /async function runSkillAction<Result>\(/);
    assert.match(skillsModuleMain, /if \(!action \|\| pendingSkillActionRef\.current !== null\) return undefined;/, 'Skills actions must reject duplicate clicks immediately');
    assert.match(skillsModuleMain, /pendingSkillActionRef\.current = actionKey[\s\S]*setPendingSkillAction\(actionKey\)[\s\S]*return await action\(\)/, 'Skills actions must show pending state while waiting for renderer IPC and preserve action results');
    assert.match(skillsModuleMain, /pendingSkillActionRef\.current = null[\s\S]*if \(skillActionMountedRef\.current\) setPendingSkillAction\(null\)/, 'Skills actions must not clear pending UI state after unmount');
    assert.match(skillsModuleMain, /className="maka-module-main-actions" role="group" aria-label=\{copy\.page\.actions\}/);
    assert.match(skillsModuleMain, /isDisabled=\{!props\.onOpenSkillsFolder \|\| skillActionBusy\}/, 'open folder button must be disabled while any Skills action is pending'); // #1565 PR 3: Astryx Button uses isDisabled
    assert.match(skillsModuleMain, /isDisabled=\{!props\.onRefreshSkills \|\| skillActionBusy\}/, 'top refresh button must be disabled while any Skills action is pending'); // #1565 PR 3
    assert.match(skillsModuleMain, /pendingSkillAction === 'refresh' \? copy\.page\.refreshing : copy\.page\.refresh/);
    assert.match(skillsModuleMain, /pendingSkillAction === 'create' \? copy\.page\.creating : copy\.page\.createExample/);
    assert.match(skillsModuleMain, /onClick=\{\(\) => void runSkillAction\('folder', props\.onOpenSkillsFolder\)\}/);
    assert.match(skillsModuleMain, /onCreateSkillTemplate=\{props\.onCreateSkillTemplate \? \(\) => runSkillAction\('create', props\.onCreateSkillTemplate\) : undefined\}/);
    assert.match(skillsModuleMain, /onOpenSkill=\{props\.onOpenSkill \? \(skillId\) => runSkillAction\(`open:\$\{skillId\}`, \(\) => props\.onOpenSkill\?\.\(skillId\)\) : undefined\}/);
    assert.match(skillsModuleMain, /onDeleteSkill=\{props\.onDeleteSkill \? \(skillId\) => runSkillAction\(`delete:\$\{skillId\}`, \(\) => props\.onDeleteSkill\?\.\(skillId\)\) : undefined\}/);

    assert.match(skillPanel, /actionBusy\?: boolean/);
    assert.match(skillPanel, /createPending\?: boolean/);
    assert.match(skillPanel, /openingSkillId\?: string \| null/);
    assert.match(skillPanel, /managedSkillSources\?: ManagedSkillSourceEntry\[]/);
    assert.match(skillPanel, /installingSourceId\?: string \| null/);
    assert.match(skillPanel, /updatingSkillId\?: string \| null/);
    assert.doesNotMatch(skillPanel, /maka-skill-workbench-rail/);
    assert.doesNotMatch(skillPanel, /maka-skill-workbench-summary/);
    // 技能示例 removed: no inert example section/grid/rows may render under the
    // installed list. 添加 seeds a real starter skill; there are no decorations.
    assert.doesNotMatch(skillPanel, /const templates = \(/);
    assert.doesNotMatch(skillPanel, /maka-skill-examples/);
    assert.doesNotMatch(skillPanel, /maka-skill-example-grid/);
    assert.doesNotMatch(skillPanel, /maka-skill-template-row/);
    assert.match(skillPanel, /<section className="maka-skill-installed" aria-label={label}>/);
    assert.match(skillPanel, /<div className="maka-skill-library" aria-busy=\{props\.actionBusy \? 'true' : undefined\}>/);
    assert.match(skillPanel, /<ul className="maka-skill-library-list" aria-label=\{copy\.installed\.listAriaLabel\}>/);
    assert.match(skillPanel, /<span className="maka-skill-library-status" aria-hidden="true">/);
    assert.match(skillPanel, /const statusLabel = formatSkillStatusLabel\(skill, copy\)/);
    assert.match(skillPanel, /const runtimeLabel = formatSkillRuntimeLabel\(skill, copy\)/);
    assert.match(skillPanel, /copy\.row\.hoverWithTools\(skill\.id, runtimeLabel, statusLabel, toolsLabel\)/);
    assert.match(skillPanel, /copy\.row\.hover\(skill\.id, runtimeLabel, statusLabel\)/);
    // Detail round 6, exception-only: the runtime badge renders ONLY for
    // state_error — enabled/disabled is already expressed by the Switch.
    // Only exceptional runtime/context/source states use Astryx Badge.
    // Routine scope, advertised/disabled context, and source are supporting text.
    assert.match(skillPanel, /\{skill\.runtimeStatus === 'state_error' && \([\s\S]*?<Badge[\s\S]*?className="maka-skill-library-runtime-label"[\s\S]*?label=\{runtimeLabel\}/);
    assert.match(skillPanel, /className="maka-skill-library-supporting"[\s\S]*?\{supportingMeta\.join\(' · '\)\}/);
    assert.doesNotMatch(skillPanel, /maka-skill-library-scope-label/);
    assert.match(skillPanel, /\{contextNeedsAttention && \([\s\S]*?<Badge[\s\S]*?className="maka-skill-library-context-exception"/);
    assert.match(skillPanel, /\{sourceStatusNeedsAttention && \([\s\S]*?<Badge[\s\S]*?className="maka-skill-library-status-label"/);
    assert.match(skillPanel, /function skillSourceStatusNeedsAttention\(skill: SkillEntry\)/);
    assert.match(ui, /function formatSkillStatusLabel\(skill: SkillEntry, copy: SkillsCopy\): string/);
    assert.match(ui, /function formatSkillRuntimeLabel\(skill: SkillEntry, copy: SkillsCopy\): string/);
    assert.match(ui, /runtimeStatus === 'state_error'\) return copy\.status\.stateError/);
    assert.match(ui, /skill\.enabled \? copy\.status\.enabled : copy\.status\.disabled/);
    assert.match(
      skillPanel,
      /disabledMessage=\{skill\.runtimeStatus === 'state_error'[\s\S]*copy\.row\.stateErrorTitle/,
      'A state-error Switch must expose its disabled reason through Astryx',
    );
    assert.doesNotMatch(
      skillPanel,
      /<Switch[\s\S]{0,500}labelTooltip=/,
      'A visually hidden Switch label must not own an unreachable tooltip',
    );
    assert.match(ui, /validationStatus === 'metadata_error'\) return copy\.status\.metadataError/);
    assert.match(ui, /userModified\) return copy\.status\.modified/);
    assert.match(ui, /sourceType === 'bundled'\) return copy\.status\.bundled/);
    assert.match(ui, /sourceType === 'managed'[\s\S]*copy\.status\.managed/, 'Phase 2 can present verified managed state derived by main');
    assert.match(ui, /return copy\.status\.local/);
    assert.match(skillEntryContract, /sourceType\?: 'workspace' \| 'bundled' \| 'managed' \| 'unknown'/);
    assert.match(skillEntryContract, /managedUpdateStatus\?:/);
    assert.match(skillEntryContract, /enabled: boolean/);
    assert.match(skillEntryContract, /runtimeStatus: 'enabled' \| 'disabled' \| 'state_error'/);
    assert.doesNotMatch(skillEntryContract, /sourceName|sourceVersion|contentSha256|installedAt|validationCodes|validationMessages|write_failed/, 'renderer SkillEntry must not expose lock internals');
    assert.match(workspaceResourcesIpc, /toSkillEntry/, 'Skills IPC must scrub main-internal lock fields before crossing to renderer');
    assert.doesNotMatch(workspaceResourcesIpc, /ipcMain\.handle\('skills:list'[\s\S]*listInstalledSkills\(deps\.workspaceRoot\)/, 'Skills list IPC must not return InstalledSkill objects directly');
    // Marketplace redesign: managed sources ARE the 市场 tab now — the
    // separate 来源库 list under 已安装 was folded into a card grid. The
    // source cache is still surfaced (never runtime), just as a browse
    // grid keyed off props.managedSkillSources.
    assert.match(skillPanel, /const market = \(/, 'Phase 2 must surface the managed source cache without making it runtime');
    assert.match(skillPanel, /<section className="maka-skill-market" aria-label=\{copy\.market\.ariaLabel\}>/);
    assert.match(skillPanel, /<div className="maka-skill-market-grid">/, '市场 tab renders managed sources as a card grid');
    assert.match(skillPanel, /const marketSources = useMemo\(/, '市场 grid is a pure client-side filter/sort over managedSkillSources');
    assert.match(skillPanel, /copy\.market\.official/, '市场 grid carries the localized official section label');
    assert.match(
      skillPanel,
      /<IconButton\s+variant="secondary"\s+size="sm"[\s\S]*?label=\{copy\.install\.action\(source\.name\)\}/,
      'only the governed install icon-button acts; the market card body stays inert',
    );
    assert.match(skillPanel, /copy\.market\.importLocal/);
    assert.doesNotMatch(skillPanel, /const managedSources = \(/, '来源库 list was replaced by the 市场 card grid');
    assert.match(skillPanel, /onInstallManagedSkill\?\(sourceId: string\): void \| Promise<void>/);
    assert.match(skillPanel, /onPreviewManagedSkillUpdate\?\(skillId: string\): Promise<ManagedSkillUpdatePreview \| null>/);
    assert.match(skillPanel, /onUpdateManagedSkill\?\(skillId: string, options\?: \{ force\?: boolean; expectedCurrentSha256\?: string; expectedSourceSha256\?: string \}\): boolean \| Promise<boolean>/);
    assert.match(skillPanel, /onSetSkillEnabled\?\(skillId: string, enabled: boolean\): void \| Promise<void>/);
    assert.match(skillPanel, /<Switch[\s\S]*value=\{skill\.enabled\}[\s\S]*onChange=\{\(next\) => props\.onSetSkillEnabled\?\.\(skillRef, next\)\}/);
    assert.match(skillPanel, /props\.onSetSkillPinned\?\.\(skillRef, !skill\.pinned\)/);
    assert.match(skillPanel, /className="maka-skill-context-inspector"/);
    assert.match(skillPanel, /data-context-status=\{contextStatus\}/);
    assert.match(
      skillEntryContract,
      /contextStatus\?:[\s\S]*'advertised'[\s\S]*'invalid'[\s\S]*'budget'/,
    );
    // Per-row delete: destructive two-step confirm (no dialog precedent here).
    // First click arms 确认删除; a second within the window fires onDeleteSkill.
    // aria-label names the skill and reflects the armed state (keyboard-safe).
    assert.match(skillPanel, /onDeleteSkill\?\(skillRef: string\): void \| Promise<void>/);
    assert.match(skillPanel, /className="maka-skill-library-delete-button"/);
    assert.match(skillPanel, /function requestDeleteSkill\(skill: SkillEntry\)/);
    // Armed state is keyed by ref, not id: the same id can appear in several
    // scopes and an id-keyed confirm would arm every copy at once.
    assert.match(skillPanel, /const ref = skill\.ref \?\? skill\.id;/);
    assert.match(skillPanel, /setConfirmingDeleteSkillId\(ref\)[\s\S]*setTimeout\([\s\S]*setConfirmingDeleteSkillId\(null\)/, 'armed delete state must auto-revert so a stray first click cannot linger');
    assert.match(skillPanel, /void props\.onDeleteSkill\(ref\)/);
    assert.match(skillPanel, /aria-label=\{confirmingDelete \? copy\.row\.confirmDeleteAriaLabel\(skill\.name\) : copy\.row\.deleteAriaLabel\(skill\.name\)\}/);
    assert.match(skillPanel, /confirmingDelete \? copy\.row\.confirmDelete : copy\.row\.delete/);
    assert.match(skillPanel, /<div[\s\S]*className="maka-skill-library-row"[\s\S]*<\/div>/, 'Skill row body must be information, not the open-file control');
    assert.match(skillPanel, /className="maka-skill-library-open-button"[\s\S]*?label=\{copy\.row\.openAriaLabel\(skill\.name\)\}/); // #1565 PR 3: Astryx icon-only Button exposes its accessible name via label
    assert.match(skillPanel, /className="maka-skill-library-open-button"[\s\S]*?\/>\s*<Switch/, 'per-skill enable switch must sit next to the explicit open-file icon button'); // #1565 PR 3: self-closing Astryx Button
    assert.match(skillPanel, /const updated = await props\.onUpdateManagedSkill\(preview\.skill\.id/);
    assert.match(skillPanel, /expectedCurrentSha256: preview\.expectedCurrentSha256/);
    assert.match(skillPanel, /expectedSourceSha256: preview\.expectedSourceSha256/);
    assert.match(skillPanel, /if \(updated\) setUpdatePreview\(null\)/);
    assert.match(skillPanel, /skill\.managedUpdateStatus === 'update_available'/);
    assert.match(skillPanel, /skill\.managedUpdateStatus === 'local_modified'/);
    assert.match(skillPanel, /copy\.row\.viewUpdate/);
    assert.match(skillPanel, /copy\.row\.viewDiff/);
    assert.match(skillPanel, /copy\.review\.overwrite/);
    assert.doesNotMatch(skillPanel, /恢复|修复|合并/, 'Phase 3 still must not imply automatic merge or repair flows');
    assert.doesNotMatch(skillPanel, /const SKILL_GOVERNANCE_FILTERS/);
    assert.doesNotMatch(skillPanel, /aria-label="技能状态筛选"/);
    assert.match(skillPanel, /sourceStatusNeedsAttention/);
    assert.match(skillPanel, /function previewText\(content: string\): string/);
    assert.doesNotMatch(skillPanel, /maka-skill-library-action/, 'Open must be an explicit file icon button, not a status-like text pill');
    assert.match(skillPanel, /label=\{props\.createPending \? copy\.installed\.createPending : copy\.installed\.createExample\}/);
    assert.match(skillPanel, /label=\{props\.refreshPending \? copy\.installed\.refreshPending : copy\.installed\.refresh\}/);
    assert.match(skillPanel, /isDisabled=\{props\.actionBusy\}/);
    assert.match(skillPanel, /aria-busy=\{props\.actionBusy \? 'true' : undefined\}/);
    assert.match(skillPanel, /isDisabled=\{props\.actionBusy \|\| !props\.onOpenSkill\}/, 'Skill open icon button must be disabled while a Skills action is pending'); // #1565 PR 3
    assert.match(skillPanel, /opening && <span>\{copy\.row\.opening\}<\/span>/);
    assert.match(skillPanel, /updating && <span>\{copy\.row\.updating\}<\/span>/);

    assert.doesNotMatch(renderer, /onRefreshSkills=\{\(\) => void refreshSkills\(\)\}/, 'renderer must return the refresh promise to the UI pending gate');
    assert.doesNotMatch(renderer, /onCreateSkillTemplate=\{\(\) => void createSkillTemplate\(\)\}/, 'renderer must return the create promise to the UI pending gate');
    assert.doesNotMatch(renderer, /onOpenSkill=\{\(skillId\) => void openSkill\(skillId\)\}/, 'renderer must return the open promise to the UI pending gate');
  });

  it('scopes Skills action feedback to the active Skills surface', async () => {
    const repoRoot = process.cwd().endsWith('apps/desktop')
      ? join(process.cwd(), '..', '..')
      : process.cwd();
    const renderer = await readRendererShellCombinedSource();
    const refreshBlock = renderer.match(/async function refreshSkills\([\s\S]*?\n  \}/)?.[0] ?? '';
    const createBlock = renderer.match(/async function createSkillTemplate\(\)[\s\S]*?async function openSkillsFolder/)?.[0] ?? '';
    const openBlock = renderer.match(/async function openSkill\(skillId: string\)[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(
      renderer,
      /function isSkillsSurfaceActive\(\): boolean \{[\s\S]*return navSelectionRef\.current\.section === 'extensions' && navSelectionRef\.current\.module === 'skills';[\s\S]*\}/,
      'Skills feedback must be owned by the current Skills surface',
    );
    assert.match(
      refreshBlock,
      /if \(options\.shouldShowError\?\.\(\) \?\? true\) \{[\s\S]*toastApi\.error\(\s*copy\.refreshSkillsFailedTitle,\s*localizedShellErrorMessage\(error, copy\.refreshSkillsFallback, uiLocale\),?\s*\);[\s\S]*\}/,
      'startup/subscription Skills refresh failures must remain visible by default',
    );
    assert.match(
      createBlock,
      /await refreshSkills\(\{ shouldShowError: isSkillsSurfaceActive \}\)/,
      'create must still refresh the Skills list while gating refresh failure feedback to the active Skills surface',
    );
    assert.match(createBlock, /if \(!isSkillsSurfaceActive\(\)\) return;/, 'create must not auto-open a starter Skill after the user leaves Skills');
    assert.doesNotMatch(createBlock, /await refreshSkills\(\);\s*toastApi\.success/, 'create success feedback must not be unconditional after refresh');
    assert.match(createBlock, /if \(isSkillsSurfaceActive\(\)\)\s*toastApi\.error\(copy\.createTemplateFailedTitle/);
    assert.match(createBlock, /if \(isSkillsSurfaceActive\(\)\)\s*toastApi\.error\(copy\.openTemplateFailedTitle/);
    // Idempotent seeding: created:false reuses the existing 示例技能 and says so
    // rather than claiming a fresh create; created:true keeps the create copy.
    assert.match(createBlock, /if \(result\.created\) \{[\s\S]*copy\.createdTemplateTitle[\s\S]*\} else \{[\s\S]*copy\.openedExistingTemplateTitle, copy\.openedExistingTemplateDescription/);
    assert.match(openBlock, /if \(isSkillsSurfaceActive\(\)\)\s*toastApi\.error\(copy\.openFailedTitle/);
    assert.doesNotMatch(openBlock, /if \(!result\.ok\) \{\s*toastApi\.error\('无法打开 Skill'/, 'open Skill structured failures must not toast unconditionally after leaving Skills');
    assert.doesNotMatch(openBlock, /catch \(error\) \{\s*toastApi\.error\('无法打开 Skill'/, 'open Skill thrown failures must not toast unconditionally after leaving Skills');
  });

  it('surfaces thrown Skills IPC failures as toasts', async () => {
    const repoRoot = process.cwd().endsWith('apps/desktop')
      ? join(process.cwd(), '..', '..')
      : process.cwd();
    const renderer = await readRendererShellCombinedSource();
    const createBlock = renderer.match(/async function createSkillTemplate\(\)[\s\S]*?async function openSkillsFolder/)?.[0] ?? '';
    const folderBlock = renderer.match(/async function openSkillsFolder\(\)[\s\S]*?async function openSkill/)?.[0] ?? '';
    const openBlock = renderer.match(/async function openSkill\(skillId: string\)[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(createBlock, /try \{[\s\S]*window\.maka\.skills\.createStarter\(\)/);
    assert.match(
      createBlock,
      /catch \(error\) \{[\s\S]*if \(isSkillsSurfaceActive\(\)\) \{[\s\S]*toastApi\.error\(\s*copy\.createTemplateFailedTitle,\s*localizedShellErrorMessage\(error, copy\.createTemplateFallback, uiLocale\),?\s*\);[\s\S]*\}/,
    );
    assert.doesNotMatch(createBlock, /toastApi\.error\('无法创建示例技能', cleanErrorMessage\(error\)\)/);
    assert.match(folderBlock, /try \{[\s\S]*window\.maka\.app\.openPath\('skills'\)/);
    assert.match(folderBlock, /catch \(error\) \{[\s\S]*toastApi\.error\([\s\S]*copy\.openFailedTitle\(openPathActionLabel\('skills', uiLocale\)\)[\s\S]*openPathActionErrorMessage\(error, 'skills', uiLocale\)/);
    assert.doesNotMatch(folderBlock, /cleanErrorMessage\(error\)/, 'Skills folder thrown openPath failures must not expose raw IPC/path details');
    assert.match(openBlock, /try \{[\s\S]*window\.maka\.skills\.open\(skillId, 'file'\)/);
    assert.match(
      openBlock,
      /catch \(error\) \{[\s\S]*if \(isSkillsSurfaceActive\(\)\) \{[\s\S]*toastApi\.error\(copy\.openFailedTitle, localizedShellErrorMessage\(error, copy\.openFallback, uiLocale\)\);[\s\S]*\}/,
    );
    assert.doesNotMatch(openBlock, /toastApi\.error\('无法打开 Skill', cleanErrorMessage\(error\)\)/);
  });

  it('parses inline and list-style allowed-tools front matter', () => {
    assert.deepEqual(
      parseSkillFrontMatter(`---
name: Inline
allowed-tools: [Read, Bash]
---
body`).allowedTools,
      ['Read', 'Bash'],
    );
    assert.deepEqual(
      parseSkillFrontMatter(`---
name: List
allowed-tools:
  - Read
  - Grep
---
body`).allowedTools,
      ['Read', 'Grep'],
    );
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
