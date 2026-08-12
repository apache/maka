import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertProductBindingCatalogClean,
  buildDeferredToolGroupsFromCatalog,
  projectEffectiveProductToolSurface,
} from '../tool-catalog-derive.js';
import type { MakaTool } from '../tool-runtime.js';
import { LOAD_TOOLS_NAME, ToolAvailabilityRuntime } from '../tool-availability.js';

function tool(name: string): MakaTool {
  return {
    name,
    description: name,
    parameters: { parse: (value: unknown) => value },
    impl: async () => null,
  };
}

describe('projectEffectiveProductToolSurface', () => {
  it('removes a disabled surface before deriving the effective binding', () => {
    const surface = projectEffectiveProductToolSurface({
      host: 'cli',
      tools: [
        tool('Bash'),
        tool('Read'),
        tool('agent_spawn'),
        tool('agent_list'),
        tool('agent_output'),
        tool('benchmark_progress'),
        tool('mcp__server__tool'),
      ],
      policy: {
        economy: true,
        disabledSurfaceIds: ['agent'],
      },
    });

    assert.deepEqual(
      surface.tools.map((candidate) => candidate.name),
      ['Bash', 'Read', 'benchmark_progress', 'mcp__server__tool'],
    );
  });

  it('removes a catalog surface that is unsupported on the selected host', () => {
    const surface = projectEffectiveProductToolSurface({
      host: 'cli',
      tools: [tool('Read'), tool('browser_navigate'), tool('mcp__server__tool')],
      policy: { economy: true },
    });

    assert.deepEqual(
      surface.tools.map((candidate) => candidate.name),
      ['Read', 'mcp__server__tool'],
    );
  });

  it('treats a scoped child binding as a hard ceiling', () => {
    const surface = projectEffectiveProductToolSurface({
      host: 'desktop',
      tools: [tool('Read'), tool('Grep')],
      policy: { economy: true },
    });

    assert.deepEqual(
      surface.tools.map((candidate) => candidate.name),
      ['Read', 'Grep'],
    );
    assert.deepEqual(surface.boundSurfaceIds, []);
    assert.deepEqual(surface.toolAvailability.groups, []);
    assert.deepEqual(surface.identity.productToolNames, ['Grep', 'Read']);
  });

  it('rejects unknown surface policy instead of silently weakening it', () => {
    assert.throws(
      () =>
        projectEffectiveProductToolSurface({
          host: 'cli',
          tools: [tool('Read')],
          policy: {
            economy: true,
            disabledSurfaceIds: ['agnet'],
          },
        }),
      /Unknown product-tool surface "agnet"/,
    );
  });
});

describe('buildDeferredToolGroupsFromCatalog', () => {
  it('includes only supported deferred surfaces that have bound members', () => {
    const groups = buildDeferredToolGroupsFromCatalog('desktop', [
      'Read',
      'maka_computer',
      'agent_spawn',
      'agent_list',
      'RiveWorkflow',
    ]);
    assert.deepEqual(groups.map((group) => group.id).sort(), ['agent', 'computer_use', 'rive']);
    const computerUse = groups.find((group) => group.id === 'computer_use');
    assert.deepEqual(computerUse?.toolNames, ['maka_computer']);
    assert.equal(computerUse?.label, 'Computer');
    const agent = groups.find((group) => group.id === 'agent');
    assert.deepEqual(agent?.toolNames, ['agent_spawn', 'agent_list']);
  });

  it('never advertises desktop-only packs on cli', () => {
    const bound = [
      'browser_navigate',
      'maka_computer',
      'RiveWorkflow',
      'agent_spawn',
      'agent_list',
      'agent_output',
    ];
    const groups = buildDeferredToolGroupsFromCatalog('cli', bound);
    assert.deepEqual(
      groups.map((group) => group.id),
      ['agent'],
    );
    assert.equal(
      groups.some((group) => ['browser', 'computer_use', 'rive'].includes(group.id)),
      false,
    );
  });
});

describe('assertProductBindingCatalogClean', () => {
  it('throws when a product name is missing from the catalog', () => {
    assert.throws(
      () => assertProductBindingCatalogClean('cli', ['Read', 'NotARealTool']),
      /cli: bound product tools missing from catalog: NotARealTool/,
    );
  });
});
