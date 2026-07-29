import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertProductBindingCatalogClean,
  buildDeferredToolGroupsFromCatalog,
  buildHostCapabilitiesFromBinding,
  projectEffectiveProductToolSurface,
} from '../tool-catalog-derive.js';
import type { MakaTool } from '../tool-runtime.js';
import { LOAD_TOOLS_NAME, type ToolGroup, ToolAvailabilityRuntime } from '../tool-availability.js';

function tool(name: string): MakaTool {
  return {
    name,
    description: name,
    parameters: { parse: (value: unknown) => value },
    permissionRequired: false,
    impl: async () => null,
  };
}

describe('projectEffectiveProductToolSurface', () => {
  it('removes a disabled surface before deriving the effective binding', () => {
    const surface = projectEffectiveProductToolSurface({
      host: 'headless',
      tools: [
        tool('Bash'),
        tool('Read'),
        tool('agent_spawn'),
        tool('agent_swarm'),
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

  it('derives every product-surface consumer from the same effective binding', () => {
    const surface = projectEffectiveProductToolSurface({
      host: 'desktop',
      tools: [
        tool('Read'),
        tool('OfficeDocument'),
        tool('OfficeDocumentEdit'),
        tool('agent_spawn'),
        tool('agent_swarm'),
        tool('agent_list'),
        tool('agent_output'),
        tool('benchmark_progress'),
        tool('mcp__server__tool'),
      ],
      policy: {
        economy: true,
        disabledSurfaceIds: ['agent', 'agent'],
      },
    });

    assert.deepEqual(
      surface.tools.map((candidate) => candidate.name),
      ['Read', 'OfficeDocument', 'OfficeDocumentEdit', 'benchmark_progress', 'mcp__server__tool'],
    );
    assert.deepEqual([...surface.toolNames].sort(), [
      'OfficeDocument',
      'OfficeDocumentEdit',
      'Read',
      'benchmark_progress',
      'mcp__server__tool',
    ]);
    assert.deepEqual([...surface.hostCapabilities.toolNames].sort(), [...surface.toolNames].sort());
    assert.deepEqual([...(surface.hostCapabilities.capabilities ?? [])], ['office']);
    assert.deepEqual(surface.toolAvailability, {
      economy: true,
      groups: [
        {
          id: 'office',
          label: 'Office',
          description: 'Read and edit Office documents (Word, Excel, PowerPoint, PDF).',
          toolNames: ['OfficeDocument', 'OfficeDocumentEdit'],
        },
      ],
    });
    assert.deepEqual(surface.boundSurfaceIds, ['office']);
    assert.deepEqual(surface.identity, {
      policy: {
        economy: true,
        disabledSurfaceIds: ['agent'],
      },
      productToolNames: ['OfficeDocument', 'OfficeDocumentEdit', 'Read'],
    });
  });

  it('keeps every derived surface snapshot immutable at runtime', () => {
    const surface = projectEffectiveProductToolSurface({
      host: 'desktop',
      tools: [tool('Read'), tool('OfficeDocument')],
      policy: { economy: true },
    });
    const group = surface.toolAvailability.groups[0];

    assert.throws(() => (surface.toolNames as Set<string>).clear(), TypeError);
    assert.throws(
      () => (surface.hostCapabilities.toolNames as Set<string>).add('Write'),
      TypeError,
    );
    assert.throws(
      () => (surface.hostCapabilities.capabilities as Set<string>).delete('office'),
      TypeError,
    );
    assert.throws(
      () => (surface.toolAvailability.groups as ToolGroup[]).push({ id: 'agent', toolNames: [] }),
      TypeError,
    );
    assert.throws(() => (group.toolNames as string[]).push('Write'), TypeError);

    const setAlgebra = surface.toolNames as ReadonlySet<string> & {
      union(other: ReadonlySet<string>): Set<string>;
      intersection(other: ReadonlySet<string>): Set<string>;
      isSubsetOf(other: ReadonlySet<unknown>): boolean;
    };
    assert.deepEqual([...setAlgebra.union(new Set(['Write']))].sort(), [
      'OfficeDocument',
      'Read',
      'Write',
    ]);
    assert.deepEqual([...setAlgebra.intersection(new Set(['Read']))], ['Read']);
    assert.equal(setAlgebra.isSubsetOf(new Set(['OfficeDocument', 'Read', 'Write'])), true);
    assert.deepEqual([...surface.toolNames].sort(), ['OfficeDocument', 'Read']);
    assert.deepEqual([...surface.hostCapabilities.toolNames].sort(), ['OfficeDocument', 'Read']);
    assert.deepEqual([...(surface.hostCapabilities.capabilities ?? [])], ['office']);
    assert.deepEqual(surface.toolAvailability.groups, [
      {
        id: 'office',
        label: 'Office',
        description: 'Read and edit Office documents (Word, Excel, PowerPoint, PDF).',
        toolNames: ['OfficeDocument'],
      },
    ]);
    assert.deepEqual(surface.identity.productToolNames, ['OfficeDocument', 'Read']);
  });

  it('removes a catalog surface that is unsupported on the selected host', () => {
    const surface = projectEffectiveProductToolSurface({
      host: 'headless',
      tools: [tool('Read'), tool('OfficeDocument'), tool('mcp__server__tool')],
      policy: { economy: true },
    });

    assert.deepEqual(
      surface.tools.map((candidate) => candidate.name),
      ['Read', 'mcp__server__tool'],
    );
  });

  it('does not let a historical load call revive a disabled surface', () => {
    const surface = projectEffectiveProductToolSurface({
      host: 'headless',
      tools: [
        tool('Read'),
        tool('agent_spawn'),
        tool('agent_swarm'),
        tool('agent_list'),
        tool('agent_output'),
      ],
      policy: {
        economy: true,
        disabledSurfaceIds: ['agent'],
      },
    });
    const plan = new ToolAvailabilityRuntime(
      surface.tools,
      surface.toolAvailability,
      tool('invalid'),
    ).prepare([
      {
        content: {
          kind: 'function_call',
          name: LOAD_TOOLS_NAME,
          args: { group: 'agent' },
        },
      },
    ]);

    assert.deepEqual(plan.activeTools, ['Read']);
    assert.equal(
      plan.providerTools.some((candidate) => candidate.name === LOAD_TOOLS_NAME),
      false,
    );
    assert.equal(
      plan.providerTools.some((candidate) => candidate.name.startsWith('agent_')),
      false,
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
          host: 'headless',
          tools: [tool('Read')],
          policy: {
            economy: true,
            disabledSurfaceIds: ['agnet'],
          },
        }),
      /Unknown product-tool surface "agnet"/,
    );
  });

  it('applies catalog affinity consistently across Desktop, CLI, and Headless', () => {
    const tools = [
      tool('Read'),
      tool('OfficeDocument'),
      tool('agent_spawn'),
      tool('agent_swarm'),
      tool('agent_list'),
      tool('agent_output'),
    ];
    const expected = {
      desktop: {
        productToolNames: [
          'OfficeDocument',
          'Read',
          'agent_list',
          'agent_output',
          'agent_spawn',
          'agent_swarm',
        ],
        groupIds: ['office', 'agent'],
      },
      cli: {
        productToolNames: ['Read', 'agent_list', 'agent_output', 'agent_spawn', 'agent_swarm'],
        groupIds: ['agent'],
      },
      headless: {
        productToolNames: ['Read', 'agent_list', 'agent_output', 'agent_spawn', 'agent_swarm'],
        groupIds: ['agent'],
      },
    } as const;

    for (const host of ['desktop', 'cli', 'headless'] as const) {
      const surface = projectEffectiveProductToolSurface({
        host,
        tools,
        policy: { economy: true },
      });
      assert.deepEqual(surface.productToolNames, expected[host].productToolNames);
      assert.deepEqual(
        surface.toolAvailability.groups.map((group) => group.id),
        expected[host].groupIds,
      );
      assert.deepEqual(surface.boundSurfaceIds, expected[host].groupIds);
      assert.deepEqual(surface.identity.productToolNames, expected[host].productToolNames);
    }
  });
});

describe('buildHostCapabilitiesFromBinding', () => {
  it('collects bound tool names and capability tags from catalog rows', () => {
    const host = buildHostCapabilitiesFromBinding(['Read', 'OfficeDocument', 'OfficeDocumentEdit']);
    assert.deepEqual([...host.toolNames].sort(), ['OfficeDocument', 'OfficeDocumentEdit', 'Read']);
    assert.deepEqual([...(host.capabilities ?? [])].sort(), ['office']);
  });

  it('omits capabilities when no bound tool carries tags', () => {
    const host = buildHostCapabilitiesFromBinding(['Read', 'Bash']);
    assert.equal(host.capabilities, undefined);
    assert.equal(host.toolNames.has('Bash'), true);
  });
});

describe('buildDeferredToolGroupsFromCatalog', () => {
  it('includes only supported deferred surfaces that have bound members', () => {
    const groups = buildDeferredToolGroupsFromCatalog('desktop', [
      'Read',
      'OfficeDocument',
      'agent_spawn',
      'agent_list',
      'RiveWorkflow',
    ]);
    assert.deepEqual(groups.map((group) => group.id).sort(), ['agent', 'office', 'rive']);
    const office = groups.find((group) => group.id === 'office');
    assert.deepEqual(office?.toolNames, ['OfficeDocument']);
    assert.equal(office?.label, 'Office');
    const agent = groups.find((group) => group.id === 'agent');
    assert.deepEqual(agent?.toolNames, ['agent_spawn', 'agent_list']);
  });

  it('never advertises desktop-only packs on cli or headless', () => {
    const bound = [
      'OfficeDocument',
      'browser_navigate',
      'maka_computer',
      'RiveWorkflow',
      'agent_spawn',
      'agent_swarm',
      'agent_list',
      'agent_output',
    ];
    for (const host of ['cli', 'headless'] as const) {
      const groups = buildDeferredToolGroupsFromCatalog(host, bound);
      assert.deepEqual(
        groups.map((group) => group.id),
        ['agent'],
      );
      assert.equal(
        groups.some((group) => ['office', 'browser', 'computer_use', 'rive'].includes(group.id)),
        false,
      );
    }
  });

  it('returns no group when a supported surface has zero bound members', () => {
    const groups = buildDeferredToolGroupsFromCatalog('desktop', ['Read', 'Bash']);
    assert.deepEqual(groups, []);
  });
});

describe('assertProductBindingCatalogClean', () => {
  it('accepts catalog product names and ignores mcp__ tools', () => {
    assert.doesNotThrow(() =>
      assertProductBindingCatalogClean('test', ['Read', 'Bash', 'mcp__server__tool']),
    );
  });

  it('throws when a product name is missing from the catalog', () => {
    assert.throws(
      () => assertProductBindingCatalogClean('cli', ['Read', 'NotARealTool']),
      /cli: bound product tools missing from catalog: NotARealTool/,
    );
  });
});
