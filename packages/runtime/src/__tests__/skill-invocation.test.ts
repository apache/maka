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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  composeSkillInvocationMessage,
  listInvocableSkills,
  prepareSkillInvocationMessage,
  resolveSkillInvocations,
} from '../skill-invocation.js';
import {
  loadSkillInstructions,
  resolveSkillDiscoveryPaths,
  writeSkillRuntimeState,
  type HostCapabilities,
  type LoadedSkillInstructions,
} from '../skills.js';
import { SKILL_INVOCATION_NAME_MAX_BYTES } from '@maka/core/skill-invocation';
import { skillInvocationInlineReferences } from '../skill-invocation-receipt.js';

describe('skill invocation', () => {
  it('projects successful receipt occurrences by request or canonical Skill id', () => {
    const displayText = 'Use /skill:writer-id, not /skill:missing';
    assert.deepEqual(
      skillInvocationInlineReferences(
        [
          {
            invocation: 'explicit',
            request: 'workspace:skills:writer-id',
            success: true,
            ref: 'workspace:skills:writer-id',
            id: 'writer-id',
            name: 'Writer',
            scope: 'workspace',
            source: 'maka',
            truncated: false,
          },
          {
            invocation: 'explicit',
            request: 'missing',
            success: false,
            reason: 'not_found',
          },
          {
            invocation: 'model_tool',
            request: 'researcher',
            success: true,
            ref: 'workspace:skills:researcher',
            id: 'researcher',
            name: 'Researcher',
            scope: 'workspace',
            source: 'maka',
            truncated: false,
          },
        ],
        displayText,
      ),
      [
        {
          kind: 'skill',
          value: '/skill:writer-id',
          label: 'Writer',
          start: displayText.indexOf('/skill:writer-id'),
        },
      ],
    );
  });

  it('bounds successful Skill references to canonical transcript limits', () => {
    const receipts = Array.from({ length: 40 }, (_, index) => ({
      invocation: 'explicit' as const,
      request: `skill-${index}`,
      success: true as const,
      ref: `project:agents:skill-${index}`,
      id: `skill-${index}`,
      name: `${'x'.repeat(199)}😀tail`,
      scope: 'project' as const,
      source: 'agents' as const,
      truncated: false,
    }));
    const references = skillInvocationInlineReferences(
      receipts,
      receipts.map((receipt) => `/skill:${receipt.id}`).join(' '),
    );
    assert.equal(references.length, 32);
    assert.equal(references[0]?.label.length, 199);
    assert.equal(references[0]?.label.endsWith('\ud83d'), false);
  });

  it('lists only enabled, host-eligible skills as slim entries', async () => {
    await withWorkspace(async (workspaceRoot, homeDir) => {
      await writeSkill(
        workspaceRoot,
        'plain-helper',
        `---
name: Plain Helper
description: Helps with plain things.
---
# Plain Helper
Do plain things.`,
      );
      await writeSkill(
        workspaceRoot,
        'gated-helper',
        `---
name: Gated Helper
description: Needs a host-specific tool.
required-tools: [ImaginaryTool]
---
# Gated Helper
Do gated things.`,
      );
      await writeSkill(
        workspaceRoot,
        'off-helper',
        `---
name: Off Helper
description: Disabled by workspace state.
---
# Off Helper`,
      );
      await writeSkillRuntimeState(workspaceRoot, new Map([['off-helper', false]]));

      const source = resolveSkillDiscoveryPaths(workspaceRoot, workspaceRoot, homeDir);
      const all = await listInvocableSkills(source);
      assert.deepEqual(
        all.map((skill) => skill.id).sort(),
        ['gated-helper', 'plain-helper'],
        'disabled skills are not invocable',
      );
      assert.deepEqual(
        Object.keys(all[0] ?? {}).sort(),
        ['description', 'id', 'name', 'ref'],
        'slim entries only',
      );

      const host: HostCapabilities = { toolNames: new Set(['Read', 'Write']) };
      const gated = await listInvocableSkills(source, host);
      assert.deepEqual(
        gated.map((skill) => skill.id),
        ['plain-helper'],
        'required-tools mismatch is hidden',
      );

      const gatedHost: HostCapabilities = { toolNames: new Set(['Read', 'ImaginaryTool']) };
      const eligible = await listInvocableSkills(source, gatedHost);
      assert.deepEqual(eligible.map((skill) => skill.id).sort(), ['gated-helper', 'plain-helper']);
    });
  });

  it('discovers skills across all standard paths with first-found-wins dedupe', async () => {
    await withWorkspace(async (workspaceRoot, homeDir) => {
      const projectDir = join(workspaceRoot, 'project');
      await writeSkillAt(
        projectDir,
        '.agents',
        'skills',
        'project-skill',
        `---
name: Project Skill
description: Project level.
---
# Project Skill`,
      );
      await writeSkillAt(
        projectDir,
        '.agents',
        'skills',
        'shadowed',
        `---
name: Project Shadow
description: Project copy wins.
---
# Project Shadow`,
      );
      await writeSkill(
        workspaceRoot,
        'shadowed',
        `---
name: Workspace Shadow
description: Workspace copy loses.
---
# Workspace Shadow`,
      );

      const source = resolveSkillDiscoveryPaths(projectDir, workspaceRoot, homeDir);
      const listed = await listInvocableSkills(source);
      const shadowed = listed.find((skill) => skill.id === 'shadowed');
      assert.deepEqual(listed.map((skill) => skill.id).sort(), ['project-skill', 'shadowed']);
      assert.equal(shadowed?.name, 'Project Shadow');
      assert.equal(shadowed?.ref, 'project:agents:shadowed');
    });
  });

  it('resolves several requests against one scan with per-request failures', async () => {
    await withWorkspace(async (workspaceRoot, homeDir) => {
      await writeSkill(
        workspaceRoot,
        'alpha',
        `---
name: Alpha
description: First.
---
# Alpha
Alpha body.`,
      );
      await writeSkill(
        workspaceRoot,
        'beta',
        `---
name: Beta
description: Second.
required-tools: [MissingTool]
---
# Beta
Beta body.`,
      );
      await writeSkill(
        workspaceRoot,
        'gamma',
        `---
name: Gamma
description: Disabled.
---
# Gamma`,
      );
      await writeSkillRuntimeState(workspaceRoot, new Map([['gamma', false]]));

      const source = resolveSkillDiscoveryPaths(workspaceRoot, workspaceRoot, homeDir);
      const host: HostCapabilities = { toolNames: new Set(['Read']) };
      const resolved = await resolveSkillInvocations(source, host, [
        'alpha',
        'Beta',
        'missing',
        'gamma',
      ]);
      assert.deepEqual(
        resolved.map((entry) => entry.request),
        ['alpha', 'Beta', 'missing', 'gamma'],
      );
      const [alpha, beta, missing, gamma] = resolved.map((entry) => entry.result);
      assert.equal(alpha.ok, true);
      if (alpha.ok) {
        assert.equal(alpha.skill.id, 'alpha');
        assert.equal(alpha.skill.instructions, '# Alpha\nAlpha body.');
        assert.equal(alpha.skill.relativePath, 'skills/alpha/SKILL.md');
      }
      assert.deepEqual(
        { ok: beta.ok, reason: !beta.ok ? beta.reason : undefined },
        { ok: false, reason: 'host_incompatible' },
        'name match still hits the host gate',
      );
      assert.deepEqual(
        { ok: missing.ok, reason: !missing.ok ? missing.reason : undefined },
        { ok: false, reason: 'not_found' },
      );
      assert.deepEqual(
        { ok: gamma.ok, reason: !gamma.ok ? gamma.reason : undefined },
        { ok: false, reason: 'disabled' },
      );
    });
  });

  it('matches loadSkillInstructions one-for-one against the same scan', async () => {
    await withWorkspace(async (workspaceRoot, homeDir) => {
      await writeSkill(
        workspaceRoot,
        'alpha',
        `---
name: Alpha
description: First.
---
# Alpha
Body.`,
      );
      const source = resolveSkillDiscoveryPaths(workspaceRoot, workspaceRoot, homeDir);
      const host: HostCapabilities = { toolNames: new Set(['Read']) };
      const [batched] = await resolveSkillInvocations(source, host, ['alpha']);
      const single = await loadSkillInstructions(source, 'alpha', host);
      assert.deepEqual(batched.result, single);
    });
  });

  it('composes trust-framed skill blocks followed by the user message', () => {
    const text = composeSkillInvocationMessage({
      userText: '帮我整理这周的进展',
      skills: [
        fakeLoadedSkill({
          id: 'weekly-report',
          name: '写周报',
          instructions: '# 写周报\n按模板整理。',
        }),
        fakeLoadedSkill({
          id: 'data<crunch>',
          name: 'Data "Crunch"',
          instructions: '# Data\nCrunch it.',
        }),
      ],
    });
    const skillSectionEnd = text.indexOf('</invoked-skill>');
    assert.ok(text.startsWith('The user explicitly invoked'), 'trust framing opens the message');
    assert.match(text, /lower priority than system, developer, safety, and permission rules/);
    assert.match(text, /do not call the Skill tool again for these skills/);
    assert.match(
      text,
      /<invoked-skill id="weekly-report" name="写周报">\n# 写周报\n按模板整理。\n<\/invoked-skill>/,
    );
    assert.match(
      text,
      /<invoked-skill id="data_crunch_" name="Data _Crunch_">/,
      'attributes are sanitized',
    );
    assert.ok(text.indexOf('data_crunch_') > skillSectionEnd - 400, 'block order is request order');
    assert.ok(text.endsWith('<user-message>\n帮我整理这周的进展\n</user-message>'));
  });

  it('falls back to a directive when the user sent invocations only', () => {
    const text = composeSkillInvocationMessage({
      userText: '   ',
      skills: [fakeLoadedSkill({ id: 'weekly-report', name: '写周报', instructions: '# 写周报' })],
    });
    assert.doesNotMatch(text, /<user-message>/);
    assert.ok(
      text.endsWith(
        'The user provided no additional task text; follow the skill instructions above.',
      ),
    );
  });

  it('preserves significant leading indentation in the user-message body', () => {
    const text = composeSkillInvocationMessage({
      userText: '    make target',
      skills: [fakeLoadedSkill({ id: 'alpha', name: 'Alpha', instructions: '# A' })],
    });
    assert.ok(
      text.endsWith('<user-message>\n    make target\n</user-message>'),
      `expected indented body preserved, got: ${text}`,
    );
  });

  it('prepares mixed success and failure tokens from one latest scan', async () => {
    await withWorkspace(async (workspaceRoot, homeDir) => {
      await writeSkill(
        workspaceRoot,
        'alpha',
        `---
name: Alpha
description: First.
---
# Alpha
Alpha body.`,
      );
      const source = resolveSkillDiscoveryPaths(workspaceRoot, workspaceRoot, homeDir);
      const prepared = await prepareSkillInvocationMessage({
        text: '/skill:alpha /skill:missing 整理一下',
        source,
        host: { toolNames: new Set(['Read']) },
      });

      assert.equal(prepared.disposition, 'ready');
      assert.deepEqual(prepared.skillInvocation.loaded, [{ id: 'alpha', name: 'Alpha' }]);
      assert.deepEqual(prepared.skillInvocation.failed, [
        { request: 'missing', reason: 'not_found' },
      ]);
      assert.deepEqual(prepared.skillInvocation.receipts, [
        {
          invocation: 'explicit',
          request: 'alpha',
          success: true,
          ref: 'workspace:legacy:alpha',
          id: 'alpha',
          name: 'Alpha',
          scope: 'workspace',
          source: 'legacy',
          truncated: false,
        },
        {
          invocation: 'explicit',
          request: 'missing',
          success: false,
          reason: 'not_found',
        },
      ]);
      assert.ok('sendText' in prepared);
      assert.match(prepared.sendText, /<invoked-skill id="alpha" name="Alpha">/);
      assert.ok(!prepared.sendText.includes('/skill:alpha'));
      assert.ok(!prepared.sendText.includes('/skill:missing'));
      assert.match(prepared.sendText, /<user-message>\n整理一下\n<\/user-message>/);
    });
  });

  it('projects long Skill metadata into a transport-bounded receipt', async () => {
    await withWorkspace(async (workspaceRoot, homeDir) => {
      const name = '😀'.repeat(100);
      await writeSkill(
        workspaceRoot,
        'long-name',
        `---\nname: ${name}\ndescription: Long display metadata.\n---\n# Long name`,
      );
      const prepared = await prepareSkillInvocationMessage({
        text: '/skill:long-name run',
        source: resolveSkillDiscoveryPaths(workspaceRoot, workspaceRoot, homeDir),
      });

      assert.equal(prepared.disposition, 'ready');
      assert.equal(
        new TextEncoder().encode(prepared.skillInvocation.loaded[0]?.name).byteLength,
        SKILL_INVOCATION_NAME_MAX_BYTES,
      );
      const receipt = prepared.skillInvocation.receipts[0];
      assert.ok(receipt?.success);
      assert.equal(receipt.name, prepared.skillInvocation.loaded[0]?.name);
      assert.match(prepared.sendText, new RegExp(name));
    });
  });

  it('reads the current state at send time and blocks when every invocation fails', async () => {
    await withWorkspace(async (workspaceRoot, homeDir) => {
      await writeSkill(
        workspaceRoot,
        'alpha',
        `---
name: Alpha
description: First.
---
# Alpha`,
      );
      const source = resolveSkillDiscoveryPaths(workspaceRoot, workspaceRoot, homeDir);
      await writeSkillRuntimeState(workspaceRoot, new Map([['alpha', false]]));
      const prepared = await prepareSkillInvocationMessage({
        text: '/skill:alpha do it',
        source,
      });

      assert.equal(prepared.disposition, 'blocked');
      assert.deepEqual(prepared.skillInvocation.loaded, []);
      assert.deepEqual(prepared.skillInvocation.failed, [{ request: 'alpha', reason: 'disabled' }]);
      assert.deepEqual(prepared.skillInvocation.receipts, [
        {
          invocation: 'explicit',
          request: 'alpha',
          success: false,
          reason: 'disabled',
        },
      ]);
    });
  });

  it('merges structured ids before text tokens and deduplicates by id', async () => {
    await withWorkspace(async (workspaceRoot, homeDir) => {
      await writeSkill(
        workspaceRoot,
        'alpha',
        `---\nname: Alpha\ndescription: First.\n---\n# Alpha`,
      );
      await writeSkill(workspaceRoot, 'beta', `---\nname: Beta\ndescription: Second.\n---\n# Beta`);
      const prepared = await prepareSkillInvocationMessage({
        text: '/skill:alpha /skill:beta finish',
        skillIds: ['workspace:legacy:beta', 'ALPHA'],
        source: resolveSkillDiscoveryPaths(workspaceRoot, workspaceRoot, homeDir),
      });

      assert.equal(prepared.disposition, 'ready');
      assert.deepEqual(
        prepared.skillInvocation.loaded.map((entry) => entry.id),
        ['beta', 'alpha'],
      );
      const firstReceipt = prepared.skillInvocation.receipts[0];
      assert.ok(firstReceipt && 'request' in firstReceipt);
      assert.equal(firstReceipt.request, 'workspace:legacy:beta');
      assert.equal(firstReceipt.success ? firstReceipt.ref : undefined, 'workspace:legacy:beta');
      assert.ok('sendText' in prepared);
      assert.ok(!prepared.sendText.includes('/skill:'));
    });
  });

  it('blocks with resolution_failed when the authoritative scan throws', async () => {
    const prepared = await prepareSkillInvocationMessage({
      text: '/skill:alpha finish',
      source: { dirs: null, stateRoot: '/invalid' } as unknown as Parameters<
        typeof prepareSkillInvocationMessage
      >[0]['source'],
    });

    assert.deepEqual(prepared, {
      disposition: 'blocked',
      skillInvocation: {
        loaded: [],
        failed: [{ request: 'alpha', reason: 'resolution_failed' }],
        receipts: [
          {
            invocation: 'explicit',
            request: 'alpha',
            success: false,
            reason: 'resolution_failed',
          },
        ],
      },
    });
  });

  it('bounds explicit invocation request diagnostics', async () => {
    await withWorkspace(async (workspaceRoot, homeDir) => {
      const prepared = await prepareSkillInvocationMessage({
        text: 'run',
        skillIds: [`bad\u0000${'x'.repeat(600)}`],
        source: resolveSkillDiscoveryPaths(workspaceRoot, workspaceRoot, homeDir),
      });
      assert.equal(prepared.disposition, 'blocked');
      assert.equal(prepared.skillInvocation.failed.length, 1);
      assert.equal(prepared.skillInvocation.receipts.length, 1);
      const failure = prepared.skillInvocation.failed[0];
      assert.ok(failure && failure.reason !== 'too_many_requests');
      assert.equal(failure.request.length, 512);
      assert.doesNotMatch(failure.request, /[\u0000-\u001F\u007F]/);
    });
  });

  it('fails closed instead of resolving a partial request set after distinct-request overflow', async () => {
    await withWorkspace(async (workspaceRoot, homeDir) => {
      await writeSkill(
        workspaceRoot,
        'alpha',
        `---\nname: Alpha\ndescription: First.\n---\n# Alpha`,
      );
      const text = [
        '/skill:alpha',
        ...Array.from({ length: 50 }, (_, index) => `/skill:missing-${index}`),
        'finish',
      ].join(' ');
      const prepared = await prepareSkillInvocationMessage({
        text,
        source: resolveSkillDiscoveryPaths(workspaceRoot, workspaceRoot, homeDir),
      });

      assert.deepEqual(prepared, {
        disposition: 'blocked',
        skillInvocation: {
          loaded: [],
          failed: [{ reason: 'too_many_requests', requestLimit: 50 }],
          receipts: [
            {
              invocation: 'explicit',
              success: false,
              reason: 'too_many_requests',
              requestLimit: 50,
            },
          ],
        },
      });
      assert.ok(!('sendText' in prepared));
    });
  });

  it('applies the distinct-request limit across structured and text inputs', async () => {
    await withWorkspace(async (workspaceRoot, homeDir) => {
      const structured = Array.from({ length: 50 }, (_, index) => `missing-${index}`);
      const source = resolveSkillDiscoveryPaths(workspaceRoot, workspaceRoot, homeDir);
      const atLimit = await prepareSkillInvocationMessage({
        text: '/skill:MISSING-0 run',
        skillIds: structured,
        source,
      });
      assert.equal(atLimit.disposition, 'blocked');
      assert.equal(atLimit.skillInvocation.failed.length, 50);
      assert.equal(
        atLimit.skillInvocation.failed.some((failure) => failure.reason === 'too_many_requests'),
        false,
      );

      const overflow = await prepareSkillInvocationMessage({
        text: '/skill:extra run',
        skillIds: structured,
        source,
      });
      assert.deepEqual(overflow.skillInvocation.failed, [
        { reason: 'too_many_requests', requestLimit: 50 },
      ]);
    });
  });
});

function fakeLoadedSkill(overrides: Partial<LoadedSkillInstructions>): LoadedSkillInstructions {
  return {
    ref: 'workspace:legacy:skill-id',
    id: 'skill-id',
    name: 'Skill Name',
    description: '',
    scope: 'workspace',
    source: 'legacy',
    declaredTools: [],
    relativePath: 'skills/skill-id/SKILL.md',
    instructions: '# Skill',
    truncated: false,
    ...overrides,
  };
}

// Tests pass an isolated homeDir so real user-level skills (~/.maka, ~/.agents)
// on the dev machine never leak into discovery results.
async function withWorkspace(
  fn: (workspaceRoot: string, homeDir: string) => Promise<void>,
): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-runtime-skill-invocation-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'maka-runtime-skill-invocation-home-'));
  try {
    await fn(workspaceRoot, homeDir);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function writeSkill(workspaceRoot: string, id: string, content: string): Promise<void> {
  await writeSkillAt(workspaceRoot, 'skills', id, content);
}

async function writeSkillAt(root: string, ...segmentsAndContent: string[]): Promise<void> {
  const content = segmentsAndContent[segmentsAndContent.length - 1];
  const segments = segmentsAndContent.slice(0, -1);
  const id = segments[segments.length - 1];
  const dir = join(root, ...segments.slice(0, -1), id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), content, 'utf8');
}
