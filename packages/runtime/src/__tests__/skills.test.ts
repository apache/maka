import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_SKILLS_PROMPT_CHARS,
  MAX_SKILL_TOOL_BODY_CHARS,
  buildSkillAgentTool,
  buildSkillAgentToolFromInventory,
  buildSkillSearchAgentTool,
  buildSkillSearchAgentToolFromInventory,
  buildSkillsPromptFragment,
  buildSkillsPromptFragmentFromInventoryWithReport,
  buildSkillsPromptFragmentWithReport,
  gateSkillsByHostCapabilities,
  loadSkillInstructions,
  readSkillRuntimeState,
  resolveSkillsPromptCharBudget,
  resolveSkillDiscoveryPaths,
  scanSkills,
  scanSkillsWithDiagnostics,
  scanWorkspaceSkills,
  searchSkills,
  selectSkillsForContext,
  SkillShadowSelectionTracker,
  validateSkillMetadata,
  writeSkillRuntimePreferences,
  writeSkillRuntimeState,
  type HostCapabilities,
  type ScannedSkill,
} from '../skills.js';
import { resolveSkillInvocations } from '../skill-invocation.js';
import type { MakaToolContext } from '../tool-runtime.js';

describe('runtime skills', () => {
  it('reports malformed and missing required metadata as structured errors', () => {
    const missingFrontmatter = validateSkillMetadata('# No metadata');
    assert.equal(missingFrontmatter.valid, false);
    assert.deepEqual(
      missingFrontmatter.issues.map((issue) => issue.code),
      ['missing_frontmatter'],
    );

    const malformed = validateSkillMetadata(`---
name: [broken
description: invalid collection syntax
---
body`);
    assert.equal(malformed.valid, false);
    assert.deepEqual(
      malformed.issues.map((issue) => issue.code),
      ['malformed_frontmatter'],
    );

    const missingRequired = validateSkillMetadata(`---
name: ''
required-tools:
  nested: invalid
required-capabilities: [workspace, 7]
---
body`);
    assert.equal(missingRequired.valid, false);
    assert.deepEqual(
      missingRequired.issues.map((issue) => issue.code),
      [
        'missing_name',
        'missing_description',
        'invalid_required_tools',
        'invalid_required_capabilities',
      ],
    );
  });

  it('keeps compatible skills loadable while reporting non-blocking metadata warnings', () => {
    const result = validateSkillMetadata(`---
name: ${'N'.repeat(65)}
description: ${'D'.repeat(1025)}
allowed-tools: [Read, Bad Tool, 7]
compatibility: ${'C'.repeat(501)}
metadata:
  author: maka
  revision: 3
category: 7
future-field: enabled
---
${'x'.repeat(MAX_SKILL_TOOL_BODY_CHARS + 1)}`);

    assert.equal(result.valid, true);
    assert.deepEqual(result.manifest.allowedTools, ['Read']);
    assert.deepEqual(result.manifest.metadata, { author: 'maka' });
    assert.deepEqual(
      result.issues.map((issue) => issue.code),
      [
        'unsupported_field',
        'name_too_long',
        'description_too_long',
        'invalid_allowed_tools',
        'compatibility_too_long',
        'invalid_metadata',
        'invalid_category',
        'body_too_large',
      ],
    );
    assert.ok(result.issues.every((issue) => issue.severity === 'warning'));
  });

  it('excludes invalid skills from the model catalog and preserves their diagnostics', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(
        workspaceRoot,
        'valid',
        `---
name: Valid
description: A valid skill.
---
# Valid`,
      );
      await writeSkill(
        workspaceRoot,
        'missing-description',
        `---
name: Missing Description
---
# Missing`,
      );
      await writeSkill(
        workspaceRoot,
        'malformed',
        `---
name: Malformed
description: [invalid collection syntax
---
# Malformed`,
      );

      const scanned = await scanSkillsWithDiagnostics(workspaceRoot);
      assert.deepEqual(
        scanned.skills.map((skill) => skill.id),
        ['valid'],
      );
      assert.deepEqual(
        scanned.rejected.map((skill) => [skill.id, skill.ref]),
        [
          ['malformed', 'workspace:legacy:malformed'],
          ['missing-description', 'workspace:legacy:missing-description'],
        ],
      );
      assert.deepEqual(
        scanned.diagnostics.map((diagnostic) => ({
          id: diagnostic.id,
          codes: diagnostic.issues.map((issue) => issue.code),
        })),
        [
          { id: 'malformed', codes: ['malformed_frontmatter'] },
          { id: 'missing-description', codes: ['missing_description'] },
        ],
      );

      const prompt = await buildSkillsPromptFragment(workspaceRoot);
      assert.ok(prompt);
      assert.match(prompt, /id="valid"/);
      assert.doesNotMatch(prompt, /missing-description|malformed/);
      const withReport = await buildSkillsPromptFragmentWithReport(workspaceRoot);
      assert.deepEqual(
        withReport.report.decisions
          .filter((decision) => decision.reason === 'invalid')
          .map((decision) => decision.id)
          .sort(),
        ['malformed', 'missing-description'],
      );

      const missing = await loadSkillInstructions(workspaceRoot, 'missing-description');
      assert.equal(missing.ok, false);
      if (missing.ok) return;
      assert.equal(missing.reason, 'not_found');
      assert.deepEqual(
        missing.availableSkills.map((skill) => skill.id),
        ['valid'],
      );
    });
  });

  it('reports deterministic duplicate id and display-name diagnostics', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'maka-runtime-skill-duplicates-'));
      try {
        await mkdir(join(projectRoot, '.agents', 'skills', 'shared'), { recursive: true });
        await writeFile(
          join(projectRoot, '.agents', 'skills', 'shared', 'SKILL.md'),
          `---
name: Shared Name
description: Higher precedence.
---
# Shared`,
          'utf8',
        );
        await writeSkill(
          workspaceRoot,
          'shared',
          `---
name: Shadowed
description: Lower precedence duplicate id.
---
# Shadowed`,
        );
        await writeSkill(
          workspaceRoot,
          'other',
          `---
name: Shared Name
description: Duplicate display name.
---
# Other`,
        );

        const scanned = await scanSkillsWithDiagnostics({
          dirs: [join(projectRoot, '.agents', 'skills'), join(workspaceRoot, 'skills')],
          stateRoot: workspaceRoot,
        });
        assert.deepEqual(
          scanned.skills.map((skill) => skill.id),
          ['shared', 'other'],
        );
        assert.deepEqual(
          scanned.diagnostics.map((diagnostic) => ({
            id: diagnostic.id,
            codes: diagnostic.issues.map((issue) => issue.code),
          })),
          [
            { id: 'shared', codes: ['duplicate_id'] },
            { id: 'shared', codes: ['duplicate_name'] },
            { id: 'other', codes: ['duplicate_name'] },
          ],
        );
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });
  });

  it('buildSkillsPromptFragment lists available skills and loadSkillInstructions loads them lazily', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(
        workspaceRoot,
        'browser-helper',
        `---
name: Browser Helper
description: Use when the user asks for browser automation.
allowed-tools:
  - Bash
  - Read
---
# Browser Helper
Open local targets carefully.
Do not ask permission for shell commands.`,
      );

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
      assert.match(loaded.skill.relativePath, /browser-helper\/SKILL\.md$/);
      assert.match(loaded.skill.instructions, /Open local targets carefully\./);
      assert.match(loaded.skill.instructions, /Do not ask permission for shell commands\./);
    });
  });

  it('writeSkillRuntimeState persists per-workspace enablement and scan excludes disabled skills', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(
        workspaceRoot,
        'browser-helper',
        `---
name: Browser Helper
description: Use when the user asks for browser automation.
---
# Browser Helper
Open local targets carefully.`,
      );
      await writeSkill(
        workspaceRoot,
        'deck-helper',
        `---
name: Deck Helper
description: Build a slide outline.
---
# Deck Helper
Make every slide carry one idea.`,
      );

      const written = await writeSkillRuntimeState(
        workspaceRoot,
        new Map([['browser-helper', false]]),
      );
      assert.equal(written.ok, true);

      const skills = await scanWorkspaceSkills(workspaceRoot);
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
      assert.deepEqual(
        blocked.availableSkills.map((skill) => skill.id),
        ['deck-helper'],
      );

      const reEnabled = await writeSkillRuntimeState(
        workspaceRoot,
        new Map([['browser-helper', true]]),
      );
      assert.equal(reEnabled.ok, true);
      const loaded = await loadSkillInstructions(workspaceRoot, 'browser-helper');
      assert.equal(loaded.ok, true);
    });
  });

  it('loadSkillInstructions loads an enabled duplicate-name skill before reporting a disabled duplicate', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(
        workspaceRoot,
        'disabled-copy',
        `---
name: Shared Helper
description: Disabled duplicate.
---
# Shared Helper
Disabled copy.`,
      );
      await writeSkill(
        workspaceRoot,
        'enabled-copy',
        `---
name: Shared Helper
description: Enabled duplicate.
---
# Shared Helper
Enabled copy.`,
      );

      assert.equal(
        (await writeSkillRuntimeState(workspaceRoot, new Map([['disabled-copy', false]]))).ok,
        true,
      );

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

  it('readSkillRuntimeState fails closed when the state file is invalid', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(
        workspaceRoot,
        'browser-helper',
        `---
name: Browser Helper
description: Use when the user asks for browser automation.
---
# Browser Helper
Open local targets carefully.`,
      );
      await mkdir(join(workspaceRoot, '.maka'), { recursive: true });
      await writeFile(join(workspaceRoot, '.maka', 'skills-state.json'), '{not json', 'utf8');

      const state = await readSkillRuntimeState(workspaceRoot);
      assert.equal(state.ok, false);
      if (state.ok) return;
      assert.equal(state.reason, 'invalid_json');

      const skills = await scanWorkspaceSkills(workspaceRoot);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].enabled, false);
      assert.equal(skills[0].runtimeStatus, 'state_error');
      assert.equal(await buildSkillsPromptFragment(workspaceRoot), undefined);

      const loaded = await loadSkillInstructions(workspaceRoot, 'browser-helper');
      assert.equal(loaded.ok, false);
      if (loaded.ok) return;
      assert.equal(loaded.reason, 'disabled');
      assert.deepEqual(loaded.availableSkills, []);

      // writeSkillRuntimeState is a low-level primitive: it does not read the
      // existing state, so a corrupted state file is repaired by overwrite.
      const repaired = await writeSkillRuntimeState(
        workspaceRoot,
        new Map([['browser-helper', true]]),
      );
      assert.equal(repaired.ok, true);
      const skillsAfter = await scanWorkspaceSkills(workspaceRoot);
      assert.equal(skillsAfter[0].enabled, true);
      assert.equal(skillsAfter[0].runtimeStatus, 'enabled');
    });
  });

  it('writeSkillRuntimeState does not write through a symlinked workspace metadata directory', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-skill-state-outside-'));
      try {
        await writeSkill(
          workspaceRoot,
          'browser-helper',
          `---
name: Browser Helper
description: Use when the user asks for browser automation.
---
# Browser Helper
Open local targets carefully.`,
        );
        await symlink(outside, join(workspaceRoot, '.maka'));

        const written = await writeSkillRuntimeState(
          workspaceRoot,
          new Map([['browser-helper', false]]),
        );
        assert.equal(written.ok, false);
        if (written.ok) return;
        assert.equal(written.reason, 'blocked_path');
        await assert.rejects(readFile(join(outside, 'skills-state.json'), 'utf8'), {
          code: 'ENOENT',
        });

        const skills = await scanWorkspaceSkills(workspaceRoot);
        assert.equal(skills.length, 1);
        assert.equal(skills[0].enabled, false);
        assert.equal(skills[0].runtimeStatus, 'state_error');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('reports blocked discovery roots instead of collapsing them into an empty catalog', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-skill-discovery-outside-'));
      const blocked = join(workspaceRoot, 'blocked-skills');
      try {
        await symlink(outside, blocked);
        const scan = await scanSkillsWithDiagnostics({
          dirs: [blocked],
          stateRoot: workspaceRoot,
          entries: [
            {
              dir: blocked,
              containmentRoot: workspaceRoot,
              scope: 'project',
              source: 'maka',
              refPrefix: 'project:maka',
            },
          ],
        });
        assert.deepEqual(scan.skills, []);
        assert.deepEqual(scan.discoveryDiagnostics, [
          {
            path: blocked,
            scope: 'project',
            source: 'maka',
            precedence: 0,
            reason: 'blocked_path',
          },
        ]);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('readSkillRuntimeState does not read through a symlinked state file', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-skill-state-file-outside-'));
      try {
        await writeSkill(
          workspaceRoot,
          'browser-helper',
          `---
name: Browser Helper
description: Use when the user asks for browser automation.
---
# Browser Helper
Open local targets carefully.`,
        );
        await mkdir(join(workspaceRoot, '.maka'), { recursive: true });
        const externalState = join(outside, 'skills-state.json');
        await writeFile(externalState, 'outside state', 'utf8');
        await symlink(externalState, join(workspaceRoot, '.maka', 'skills-state.json'));

        const state = await readSkillRuntimeState(workspaceRoot);
        assert.equal(state.ok, false);
        if (state.ok) return;
        assert.equal(state.reason, 'blocked_path');

        const skills = await scanWorkspaceSkills(workspaceRoot);
        assert.equal(skills.length, 1);
        assert.equal(skills[0].enabled, false);
        assert.equal(skills[0].runtimeStatus, 'state_error');
        assert.equal(await buildSkillsPromptFragment(workspaceRoot), undefined);
        assert.equal(await readFile(externalState, 'utf8'), 'outside state');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('buildSkillAgentTool exposes a read-only Skill tool that loads a single matching local skill', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(
        workspaceRoot,
        'deck-helper',
        `---
name: Deck Helper
description: Build a slide outline.
allowed-tools: [Read, Bash]
---
# Deck Helper
Make every slide carry one idea.`,
      );

      const tool = buildSkillAgentTool(workspaceRoot);
      assert.equal(tool.name, 'Skill');
      const result = await tool.impl(
        { name: 'Deck Helper' },
        {
          sessionId: 's1',
          turnId: 't1',
          cwd: workspaceRoot,
          toolCallId: 'tool-1',
          abortSignal: new AbortController().signal,
          emitOutput: () => {},
        },
      );

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.skill.id, 'deck-helper');
      assert.match(result.skill.instructions, /Make every slide carry one idea\./);
    });
  });

  it('buildSkillAgentTool resolves project skills from each tool call cwd', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const firstProject = join(workspaceRoot, 'first-project');
      const secondProject = join(workspaceRoot, 'second-project');
      await mkdir(join(firstProject, '.agents', 'skills', 'project-helper'), { recursive: true });
      await mkdir(join(secondProject, '.agents', 'skills', 'project-helper'), { recursive: true });
      await writeFile(
        join(firstProject, '.agents', 'skills', 'project-helper', 'SKILL.md'),
        `---
name: Project Helper
description: First project helper.
---
# First project`,
        'utf8',
      );
      await writeFile(
        join(secondProject, '.agents', 'skills', 'project-helper', 'SKILL.md'),
        `---
name: Project Helper
description: Second project helper.
---
# Second project`,
        'utf8',
      );

      const tool = buildSkillAgentTool((ctx) => resolveSkillDiscoveryPaths(ctx.cwd, workspaceRoot));
      const result = await tool.impl(
        { name: 'Project Helper' },
        {
          sessionId: 's2',
          turnId: 't2',
          cwd: secondProject,
          toolCallId: 'tool-2',
          abortSignal: new AbortController().signal,
          emitOutput: () => {},
        },
      );

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.match(result.skill.instructions, /# Second project/);
      assert.doesNotMatch(result.skill.instructions, /# First project/);
    });
  });

  it('loadSkillInstructions bounds loaded instructions and returns available skills on miss', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(
        workspaceRoot,
        'huge',
        `---
name: Huge
description: Exercise bounded instruction loading.
---
# Huge
${'A'.repeat(MAX_SKILL_TOOL_BODY_CHARS + 1000)}`,
      );

      const loaded = await loadSkillInstructions(workspaceRoot, 'huge');
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;
      assert.equal(loaded.skill.truncated, true);
      assert.ok(
        loaded.skill.instructions.length <=
          MAX_SKILL_TOOL_BODY_CHARS + '[skill truncated]'.length + 2,
      );
      assert.match(loaded.skill.instructions, /\[skill truncated\]/);

      const miss = await loadSkillInstructions(workspaceRoot, 'missing');
      assert.equal(miss.ok, false);
      if (miss.ok) return;
      assert.equal(miss.reason, 'not_found');
      assert.deepEqual(miss.availableSkills, [
        {
          id: 'huge',
          name: 'Huge',
          description: 'Exercise bounded instruction loading.',
        },
      ]);
    });
  });

  it('buildSkillAgentTool honors the host capability gate when loading skills', async () => {
    await withWorkspace(async (workspaceRoot) => {
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

      const tool = buildSkillAgentTool(workspaceRoot, { toolNames: new Set(['Read']) });
      const result = await tool.impl({ name: 'gated-helper' }, {} as unknown as MakaToolContext);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.reason, 'host_incompatible');
    });
  });

  it('loadSkillInstructions rejects skills hidden by the host capability gate with host_incompatible', async () => {
    await withWorkspace(async (workspaceRoot) => {
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

      // Host without the required tool: load returns host_incompatible, no available skills.
      const hidden = await loadSkillInstructions(workspaceRoot, 'gated-helper', {
        toolNames: new Set(['Read']),
      });
      assert.equal(hidden.ok, false);
      if (hidden.ok) return;
      assert.equal(hidden.reason, 'host_incompatible');
      assert.deepEqual(hidden.availableSkills, []);

      // Host with the required tool: load succeeds.
      const ok = await loadSkillInstructions(workspaceRoot, 'gated-helper', {
        toolNames: new Set(['Read', 'ImaginaryTool']),
      });
      assert.equal(ok.ok, true);
    });
  });

  it('resolves the Skill tool host per session', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await writeSkill(
        workspaceRoot,
        'gated-helper',
        `---
name: Gated Helper
description: Host-specific work.
required-tools: [ImaginaryTool]
---
# Gated Helper
Use host tools.`,
      );
      const hosts = new Map([
        ['text-session', { toolNames: new Set<string>(['Read']) }],
        ['full-session', { toolNames: new Set<string>(['Read', 'ImaginaryTool']) }],
      ]);
      const tool = buildSkillAgentTool(
        workspaceRoot,
        ({ sessionId }) => hosts.get(sessionId) ?? { toolNames: new Set<string>() },
      );

      const hidden = await tool.impl({ name: 'gated-helper' }, {
        sessionId: 'text-session',
      } as unknown as MakaToolContext);
      assert.equal(hidden.ok, false);
      if (!hidden.ok) assert.equal(hidden.reason, 'host_incompatible');

      const loaded = await tool.impl({ name: 'gated-helper' }, {
        sessionId: 'full-session',
      } as unknown as MakaToolContext);
      assert.equal(loaded.ok, true);
    });
  });

  it('buildSkillsPromptFragment filters out skills whose required tools are missing on the host', async () => {
    await withWorkspace(async (workspaceRoot) => {
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

      // Host without the required tool: gated-helper is hidden, plain-helper is shown.
      const prompt = await buildSkillsPromptFragment(workspaceRoot, {
        toolNames: new Set(['Read']),
      });
      assert.ok(prompt);
      assert.match(prompt, /<available-skill id="plain-helper"/);
      assert.doesNotMatch(prompt, /<available-skill id="gated-helper"/);

      // Host with the required tool: both are shown.
      const full = await buildSkillsPromptFragment(workspaceRoot, {
        toolNames: new Set(['Read', 'ImaginaryTool']),
      });
      assert.ok(full);
      assert.match(full, /<available-skill id="plain-helper"/);
      assert.match(full, /<available-skill id="gated-helper"/);
    });
  });

  it('gateSkillsByHostCapabilities hard-hides skills whose required tools are missing and only hints at missing declared tools', () => {
    const skills: ScannedSkill[] = [
      {
        ref: 'workspace:legacy:gated',
        id: 'gated',
        name: 'Gated',
        description: '',
        path: '/p',
        declaredTools: ['Read', 'ImaginaryTool'],
        requiredTools: ['ImaginaryTool'],
        requiredCapabilities: [],
        enabled: true,
        pinned: false,
        runtimeStatus: 'enabled',
        scope: 'workspace',
        source: 'legacy',
        precedence: 0,
        content: '',
        contentSha256: 'sha256:x',
        discoveryRoot: '/p',
      },
      {
        ref: 'workspace:legacy:plain',
        id: 'plain',
        name: 'Plain',
        description: '',
        path: '/p',
        declaredTools: ['Bash'],
        requiredTools: [],
        requiredCapabilities: [],
        enabled: true,
        pinned: false,
        runtimeStatus: 'enabled',
        scope: 'workspace',
        source: 'legacy',
        precedence: 0,
        content: '',
        contentSha256: 'sha256:y',
        discoveryRoot: '/p',
      },
    ];
    const host: HostCapabilities = { toolNames: new Set(['Read']) };
    const gated = gateSkillsByHostCapabilities(skills, host);
    const gatedSkill = gated.find((g) => g.id === 'gated')!;
    assert.equal(gatedSkill.eligible, false);
    assert.equal(gatedSkill.hiddenReason, 'required_tools_missing');
    assert.deepEqual(gatedSkill.missingDeclaredTools, ['ImaginaryTool']);
    const plain = gated.find((g) => g.id === 'plain')!;
    assert.equal(plain.eligible, true);
    assert.equal(plain.hiddenReason, undefined);
    assert.deepEqual(plain.missingDeclaredTools, ['Bash']);
  });

  it('gateSkillsByHostCapabilities hides skills whose required capabilities are missing', () => {
    const skills: ScannedSkill[] = [
      {
        ref: 'workspace:legacy:cap',
        id: 'cap',
        name: 'Cap',
        description: '',
        path: '/p',
        declaredTools: [],
        requiredTools: [],
        requiredCapabilities: ['specialized'],
        enabled: true,
        pinned: false,
        runtimeStatus: 'enabled',
        scope: 'workspace',
        source: 'legacy',
        precedence: 0,
        content: '',
        contentSha256: 'sha256:z',
        discoveryRoot: '/p',
      },
    ];
    const noCap = gateSkillsByHostCapabilities(skills, {
      toolNames: new Set(),
      capabilities: new Set(),
    });
    assert.equal(noCap[0].eligible, false);
    assert.equal(noCap[0].hiddenReason, 'required_capabilities_missing');
    const withCap = gateSkillsByHostCapabilities(skills, {
      toolNames: new Set(),
      capabilities: new Set(['specialized']),
    });
    assert.equal(withCap[0].eligible, true);
    assert.equal(withCap[0].hiddenReason, undefined);
  });

  it('scanSkills discovers skills from multiple directories and dedupes by id (first-found wins)', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'maka-runtime-skills-proj-'));
      try {
        // Write a skill in the project .agents/skills path
        await mkdir(join(projectRoot, '.agents', 'skills', 'shared'), { recursive: true });
        await writeFile(
          join(projectRoot, '.agents', 'skills', 'shared', 'SKILL.md'),
          `---
name: Shared
description: Project copy.
---
# Shared
Project body.`,
          'utf8',
        );

        // Write the same id in the workspace skills path
        await writeSkill(
          workspaceRoot,
          'shared',
          `---
name: Shared
description: Workspace copy.
---
# Shared
Workspace body.`,
        );

        // Write a unique skill in project .agents/skills
        await mkdir(join(projectRoot, '.agents', 'skills', 'project-only'), { recursive: true });
        await writeFile(
          join(projectRoot, '.agents', 'skills', 'project-only', 'SKILL.md'),
          `---
name: Project Only
description: Only in project.
---
# Project Only
Body.`,
          'utf8',
        );

        const source = {
          dirs: [join(projectRoot, '.agents', 'skills'), join(workspaceRoot, 'skills')],
          stateRoot: workspaceRoot,
        };
        const skills = await scanSkills(source);
        const ids = skills.map((s) => s.id);
        assert.ok(ids.includes('shared'));
        assert.ok(ids.includes('project-only'));
        // Only one 'shared' despite two dirs
        assert.equal(ids.filter((id) => id === 'shared').length, 1);
        // First-found (project) wins
        const shared = skills.find((s) => s.id === 'shared')!;
        assert.equal(shared.description, 'Project copy.');
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });
  });

  it('resolveSkillDiscoveryPaths returns the five standard paths with containment roots in precedence order', () => {
    const { entries, dirs, stateRoot } = resolveSkillDiscoveryPaths(
      '/repo',
      '/workspace',
      '/home/user',
    );
    assert.deepEqual(entries, [
      { dir: '/repo/.maka/skills', containmentRoot: '/repo', scope: 'project', source: 'maka' },
      { dir: '/repo/.agents/skills', containmentRoot: '/repo', scope: 'project', source: 'agents' },
      {
        dir: '/workspace/skills',
        containmentRoot: '/workspace',
        scope: 'workspace',
        source: 'legacy',
      },
      {
        dir: '/home/user/.maka/skills',
        containmentRoot: '/home/user',
        scope: 'user',
        source: 'maka',
      },
      {
        dir: '/home/user/.agents/skills',
        containmentRoot: '/home/user',
        scope: 'user',
        source: 'agents',
      },
    ]);
    assert.deepEqual(dirs, [
      '/repo/.maka/skills',
      '/repo/.agents/skills',
      '/workspace/skills',
      '/home/user/.maka/skills',
      '/home/user/.agents/skills',
    ]);
    assert.equal(stateRoot, '/workspace');
  });

  it('buildSkillsPromptFragment does not impose an arbitrary count limit', async () => {
    await withWorkspace(async (workspaceRoot) => {
      for (let index = 1; index <= 15; index += 1) {
        const id = `small-${String(index).padStart(2, '0')}`;
        await writeSkill(
          workspaceRoot,
          id,
          `---\nname: Small ${index}\ndescription: Short.\n---\n# Small ${index}`,
        );
      }
      const prompt = await buildSkillsPromptFragment(workspaceRoot);
      assert.ok(prompt);
      for (let index = 1; index <= 15; index += 1) {
        const id = `small-${String(index).padStart(2, '0')}`;
        assert.match(prompt, new RegExp(`id="${id}"`));
      }
      assert.doesNotMatch(prompt, /omitted from this prompt/);
    });
  });

  it('buildSkillsPromptFragment truncates by char budget without expanding every omitted id', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const longDescription = 'x'.repeat(1200);
      for (let index = 1; index <= 20; index += 1) {
        const id = `big-${String(index).padStart(2, '0')}`;
        await writeSkill(
          workspaceRoot,
          id,
          `---\nname: Big ${index}\ndescription: ${longDescription}\n---\n# Big ${index}`,
        );
      }
      const result = await buildSkillsPromptFragmentWithReport(workspaceRoot, undefined, {
        contextWindow: 128_000,
      });
      const prompt = result.text;
      assert.ok(prompt);
      const promptCharBudget = resolveSkillsPromptCharBudget({ contextWindow: 128_000 });
      assert.ok(
        prompt.length <= promptCharBudget,
        'prompt should stay within its character budget',
      );
      assert.match(prompt, /omitted from this prompt due to the prompt budget/);
      assert.match(prompt, /Use SkillSearch to find them/);
      const omitted = result.report.decisions.filter((decision) => decision.reason === 'budget');
      assert.ok(omitted.length > 0);
      for (const decision of omitted) {
        assert.doesNotMatch(prompt, new RegExp(`Ref: ${decision.ref}`));
        const loaded = await loadSkillInstructions(workspaceRoot, decision.ref);
        assert.equal(
          loaded.ok,
          true,
          `omitted skill ${decision.ref} should still be loadable via the Skill tool`,
        );
      }
    });
  });

  it('keeps a scope-aware inventory while retaining only the highest-precedence duplicate', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const projectRoot = join(workspaceRoot, 'project');
      const homeDir = join(workspaceRoot, 'home');
      await mkdir(projectRoot, { recursive: true });
      await mkdir(homeDir, { recursive: true });
      await writeSkillInDirectory(
        join(projectRoot, '.maka', 'skills'),
        'writer',
        'Project Writer',
        'Project-scoped writing workflow.',
      );
      await writeSkillInDirectory(
        join(homeDir, '.agents', 'skills'),
        'writer',
        'User Writer',
        'User-scoped writing workflow.',
      );

      const source = resolveSkillDiscoveryPaths(projectRoot, workspaceRoot, homeDir);
      const scan = await scanSkillsWithDiagnostics(source);
      assert.equal(scan.skills.length, 1);
      assert.equal(scan.inventory.length, 2);
      assert.equal(scan.skills[0].scope, 'project');
      assert.equal(scan.skills[0].source, 'maka');
      assert.equal(scan.skills[0].ref, 'project:maka:writer');
      assert.equal(scan.inventory[1].scope, 'user');
      assert.equal(scan.inventory[1].source, 'agents');
      assert.equal(scan.inventory[1].shadowedBy, scan.skills[0].ref);
      assert.ok(
        scan.diagnostics.some((diagnostic) =>
          diagnostic.issues.some((issue) => issue.code === 'duplicate_id'),
        ),
      );
    });
  });

  it('uses one canonical inventory for prompt, Skill, and SkillSearch without exposing shadowed duplicates', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const projectRoot = join(workspaceRoot, 'project');
      const homeDir = join(workspaceRoot, 'home');
      await mkdir(projectRoot, { recursive: true });
      await mkdir(homeDir, { recursive: true });
      await writeSkillInDirectory(
        join(projectRoot, '.maka', 'skills'),
        'writer',
        'Project Writer',
        'Project active quill workflow.',
      );
      await writeSkillInDirectory(
        join(homeDir, '.agents', 'skills'),
        'writer',
        'User Writer',
        'Obsidian lantern archival workflow.',
      );

      const source = resolveSkillDiscoveryPaths(projectRoot, workspaceRoot, homeDir);
      const scan = await scanSkillsWithDiagnostics(source);
      const prompt = buildSkillsPromptFragmentFromInventoryWithReport(scan.inventory);
      assert.match(prompt.text ?? '', /Project active quill workflow/);
      assert.doesNotMatch(prompt.text ?? '', /Obsidian lantern archival workflow/);
      assert.equal(
        prompt.report.decisions.some(
          (decision) => decision.ref === 'user:agents:writer' && decision.reason === 'shadowed',
        ),
        true,
      );

      const resolveInventory = async () => scan.inventory;
      const skillTool = buildSkillAgentToolFromInventory(resolveInventory);
      const searchTool = buildSkillSearchAgentToolFromInventory(resolveInventory);
      const context = {
        sessionId: 'session-1',
        turnId: 'turn-1',
        cwd: projectRoot,
      } as MakaToolContext;

      const loaded = await skillTool.impl({ name: 'writer' }, context);
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;
      assert.equal(loaded.skill.ref, 'project:maka:writer');
      assert.match(loaded.skill.instructions, /Project Writer/);
      assert.doesNotMatch(loaded.skill.instructions, /User Writer/);

      const shadowed = await skillTool.impl({ name: 'user:agents:writer' }, context);
      assert.equal(shadowed.ok, false);
      if (shadowed.ok) return;
      assert.equal(shadowed.reason, 'not_found');

      const searched = await searchTool.impl({ query: 'obsidian lantern' }, context);
      assert.equal(searched.totalEligible, 1);
      assert.deepEqual(searched.matches, []);
    });
  });

  it('re-evaluates zero-match schema v2 bare preferences after multi-scope discovery changes', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const projectRoot = join(workspaceRoot, 'project');
      const homeDir = join(workspaceRoot, 'home');
      await mkdir(projectRoot, { recursive: true });
      await mkdir(homeDir);
      await mkdir(join(workspaceRoot, '.maka'), { recursive: true });
      await writeFile(
        join(workspaceRoot, '.maka', 'skills-state.json'),
        JSON.stringify({
          schemaVersion: 2,
          skills: { Future: { enabled: false, pinned: true } },
        }),
        'utf8',
      );
      const source = resolveSkillDiscoveryPaths(projectRoot, workspaceRoot, homeDir);

      const beforeDiscovery = await scanSkillsWithDiagnostics(source);
      assert.equal(beforeDiscovery.runtimeState.ok, true);
      if (!beforeDiscovery.runtimeState.ok) return;
      assert.equal(beforeDiscovery.runtimeState.preferences.has('Future'), true);
      assert.equal(beforeDiscovery.runtimeState.needsReview.size, 0);

      await writeSkillInDirectory(
        join(projectRoot, '.maka', 'skills'),
        'future',
        'Project Future',
        'Project future workflow.',
      );
      await writeSkillInDirectory(
        join(homeDir, '.agents', 'skills'),
        'Future',
        'User Future',
        'User future workflow.',
      );

      const afterDiscovery = await scanSkillsWithDiagnostics(source);
      assert.equal(afterDiscovery.runtimeState.ok, true);
      if (!afterDiscovery.runtimeState.ok) return;
      assert.deepEqual([...afterDiscovery.runtimeState.needsReview], ['Future']);
      assert.equal(afterDiscovery.inventory.length, 2);
      assert.equal(
        afterDiscovery.inventory.every((skill) => !skill.enabled && skill.pinned),
        true,
      );
    });
  });

  it('selects pinned skills first and explains every inventory decision', async () => {
    await withWorkspace(async (workspaceRoot) => {
      for (const [id, name] of [
        ['alpha', 'Alpha'],
        ['zulu', 'Zulu'],
      ] as const) {
        await writeSkill(
          workspaceRoot,
          id,
          `---\nname: ${name}\ndescription: ${'x'.repeat(200)}\n---\n# ${name}`,
        );
      }
      await writeSkillRuntimePreferences(
        workspaceRoot,
        new Map([['workspace:legacy:zulu', { enabled: true, pinned: true }]]),
      );
      const scan = await scanSkillsWithDiagnostics(workspaceRoot);
      const selection = selectSkillsForContext(scan.inventory);
      assert.deepEqual(
        selection.advertised.map((skill) => skill.id),
        ['zulu', 'alpha'],
      );
      assert.deepEqual(
        selection.report.decisions
          .filter((decision) => decision.reason === 'advertised')
          .map((decision) => [decision.id, decision.rank]),
        [
          ['zulu', 1],
          ['alpha', 2],
        ],
      );
      assert.equal(selection.report.totalCount, 2);
      assert.equal(selection.report.usedChars <= selection.report.budgetChars, true);
    });
  });

  it('bounds SkillSearch results and records search-to-load ranking telemetry', async () => {
    await withWorkspace(async (workspaceRoot) => {
      for (let index = 1; index <= 12; index += 1) {
        await writeSkill(
          workspaceRoot,
          `report-${String(index).padStart(2, '0')}`,
          `---\nname: Weekly Report ${index}\ndescription: Prepare a weekly report and status summary.\n---\n# Report`,
        );
      }
      const scan = await scanSkillsWithDiagnostics(workspaceRoot);
      const bounded = searchSkills(scan.inventory, 'weekly report', undefined, 99);
      assert.equal(bounded.matches.length, 8);
      assert.equal(bounded.matchedCount, 12);
      assert.equal(bounded.queryTruncated, false);
      assert.equal(bounded.truncated, true);
      assert.equal(
        bounded.matches.every((match) => !('path' in match) && !('content' in match)),
        true,
      );
      assert.equal(searchSkills(scan.inventory, 'x'.repeat(600)).queryTruncated, true);

      const tracker = new SkillShadowSelectionTracker();
      const searchTool = buildSkillSearchAgentTool(workspaceRoot, undefined, {
        shadowTracker: tracker,
      });
      const loadTool = buildSkillAgentTool(workspaceRoot, undefined, { shadowTracker: tracker });
      const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
      const context = {
        sessionId: 'session-1',
        turnId: 'turn-1',
        cwd: workspaceRoot,
        emitRunTrace: (type: string, _message: string, data?: Record<string, unknown>) => {
          events.push({ type, data });
        },
      } as unknown as MakaToolContext;
      const searched = await searchTool.impl({ query: 'weekly report', limit: 3 }, context);
      assert.equal(searched.matches.length, 3);
      const loaded = await loadTool.impl({ name: searched.matches[1].ref }, context);
      assert.equal(loaded.ok, true);
      const missing = await loadTool.impl({ name: 'private-looking-missing-name' }, context);
      assert.equal(missing.ok, false);
      assert.deepEqual(
        events.map((event) => event.type),
        ['skill_searched', 'skill_loaded', 'skill_load_failed'],
      );
      assert.equal(events[0].data?.resultCount, 3);
      assert.equal(events[0].data?.candidateReductionRatio, 0.75);
      assert.equal(events[0].data?.query, undefined, 'raw search text must not enter telemetry');
      assert.equal(events[1].data?.shadowRank, 2);
      assert.equal(events[1].data?.shadowCandidateCount, 12);
      assert.equal(events[1].data?.shadowHitAt1, false);
      assert.equal(events[1].data?.shadowHitAt5, true);
      assert.equal(events[1].data?.shadowHitAt20, true);
      assert.equal(events[1].data?.skillScope, 'workspace');
      assert.equal(events[1].data?.skillSource, 'legacy');
      assert.equal(events[1].data?.invocation, 'model_tool');
      assert.equal(events[1].data?.success, true);
      assert.equal(events[2].data?.request, undefined);
      assert.equal(events[2].data?.requestChars, 'private-looking-missing-name'.length);
      assert.equal(events[2].data?.invocation, 'model_tool');
      assert.equal(events[2].data?.reason, 'not_found');
    });
  });
});

async function withWorkspace(fn: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-runtime-skills-'));
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

async function writeSkillInDirectory(
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
