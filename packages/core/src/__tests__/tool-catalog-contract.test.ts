/**
 * Tool catalog contract — structural invariants over the shared product vocabulary (#1099 S1).
 *
 * The catalog is the name authority for every product tool host.
 * Host wiring (S2) and /tools (S3) consume it; this file only asserts catalog shape.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAKA_CATALOG_SURFACES,
  MAKA_CATALOG_TOOLS,
  TOOL_HOST_IDS,
  catalogToolByName,
  catalogToolNameSet,
  unknownBoundToolNames,
  type ToolHostId,
} from '../tool-catalog.js';

describe('tool catalog contract', () => {
  it('gives every tool a unique non-empty name', () => {
    const seen = new Set<string>();
    for (const tool of MAKA_CATALOG_TOOLS) {
      assert.ok(tool.name.trim().length > 0, 'tool name must be non-empty');
      assert.equal(seen.has(tool.name), false, `duplicate tool name: ${tool.name}`);
      seen.add(tool.name);
    }
    assert.equal(seen.size, MAKA_CATALOG_TOOLS.length);
    assert.equal(catalogToolNameSet().size, MAKA_CATALOG_TOOLS.length);
  });

  it('gives every surface a unique id, labels, and deferred economy', () => {
    const seen = new Set<string>();
    for (const surface of MAKA_CATALOG_SURFACES) {
      assert.ok(surface.id.trim().length > 0, 'surface id must be non-empty');
      assert.ok(surface.label.trim().length > 0, `${surface.id} label`);
      assert.ok(surface.description.trim().length > 0, `${surface.id} description`);
      assert.equal(surface.economy, 'deferred', `${surface.id} must be deferred in v1`);
      assert.equal(seen.has(surface.id), false, `duplicate surface id: ${surface.id}`);
      seen.add(surface.id);
    }
  });

  it('requires every surface member to be a catalog tool row', () => {
    for (const surface of MAKA_CATALOG_SURFACES) {
      assert.ok(surface.toolNames.length > 0, `${surface.id} must list tools`);
      for (const name of surface.toolNames) {
        assert.ok(catalogToolByName(name), `surface ${surface.id} references unknown tool ${name}`);
      }
    }
  });

  it('declares host affinity for every host id on every surface', () => {
    for (const surface of MAKA_CATALOG_SURFACES) {
      for (const host of TOOL_HOST_IDS) {
        const support = surface.hosts[host];
        assert.ok(
          support === 'supported' || support === 'unsupported',
          `${surface.id}.${host} must be supported|unsupported, got ${String(support)}`,
        );
      }
    }
  });

  it('marks desktop-owned packs unsupported on cli and headless', () => {
    for (const id of ['browser', 'computer_use', 'rive'] as const) {
      const surface = MAKA_CATALOG_SURFACES.find((entry) => entry.id === id);
      assert.ok(surface, `missing surface ${id}`);
      assert.equal(surface.hosts.desktop, 'supported');
      assert.equal(surface.hosts.cli, 'unsupported');
      assert.equal(surface.hosts.headless, 'unsupported');
    }
  });

  it('keeps agent pack supported where hosts can bind child agents', () => {
    const agent = MAKA_CATALOG_SURFACES.find((entry) => entry.id === 'agent');
    assert.ok(agent);
    assert.equal(agent.hosts.desktop, 'supported');
    assert.equal(agent.hosts.cli, 'supported');
    assert.equal(agent.hosts.headless, 'supported');
  });

  it('reports bound names missing from the catalog', () => {
    assert.deepEqual(unknownBoundToolNames(['Read', 'NotARealTool', 'Bash']), ['NotARealTool']);
    assert.deepEqual(unknownBoundToolNames(['Read', 'Bash']), []);
  });

  it('freezes catalog tables and isolates surface host affinity', () => {
    assert.equal(Object.isFrozen(MAKA_CATALOG_TOOLS), true);
    assert.equal(Object.isFrozen(MAKA_CATALOG_SURFACES), true);

    const computerUse = MAKA_CATALOG_SURFACES.find((entry) => entry.id === 'computer_use');
    const browser = MAKA_CATALOG_SURFACES.find((entry) => entry.id === 'browser');
    assert.ok(computerUse && browser);
    assert.equal(Object.isFrozen(computerUse), true);
    assert.equal(Object.isFrozen(computerUse.hosts), true);
    assert.equal(Object.isFrozen(computerUse.toolNames), true);
    assert.notEqual(computerUse.hosts, browser.hosts);

    assert.throws(() => {
      // @ts-expect-error intentional mutation probe against frozen hosts
      computerUse.hosts.cli = 'supported';
    }, TypeError);
    assert.equal(computerUse.hosts.cli, 'unsupported');
    assert.equal(browser.hosts.cli, 'unsupported');

    const names = catalogToolNameSet() as Set<string>;
    names.add('__probe__');
    assert.equal(catalogToolNameSet().has('__probe__'), false);
  });

  it('covers expected host fixture names as catalog subsets', () => {
    // Optional fixtures for S2: each host's known product tools must already be catalog rows.
    // Desktop omits Edit: main filters it out of buildBuiltinTools.
    const fixtures: Record<ToolHostId, readonly string[]> = {
      desktop: [
        'Bash',
        'Read',
        'Write',
        'Glob',
        'Grep',
        'FormatJson',
        'StopBackgroundTask',
        'WriteStdin',
        'AskUserQuestion',
        'request_sandbox_boundary',
        'Skill',
        'WebSearch',
        'ExploreAgent',
        'Automation',
        'GoalSet',
        'GoalClear',
        'GoalStatus',
        'GoalPause',
        'GoalResume',
        'task_create',
        'task_update',
        'task_list',
        'task_get',
        'browser_navigate',
        'browser_snapshot',
        'browser_click',
        'browser_type',
        'browser_wait',
        'browser_extract',
        'maka_computer',
        'RiveWorkflow',
        'agent_spawn',
        'agent_swarm',
        'agent_list',
        'agent_output',
      ],
      cli: [
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'FormatJson',
        'StopBackgroundTask',
        'WriteStdin',
        'AskUserQuestion',
        'request_sandbox_boundary',
        'Skill',
        'Automation',
        'GoalSet',
        'GoalClear',
        'GoalStatus',
        'GoalPause',
        'GoalResume',
        'agent_spawn',
        'agent_swarm',
        'agent_list',
        'agent_output',
      ],
      headless: [
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'agent_spawn',
        'agent_swarm',
        'agent_list',
        'agent_output',
      ],
      'runtime-host': [
        'AskUserQuestion',
        'Skill',
        'SkillSearch',
        'task_create',
        'task_update',
        'task_list',
        'task_get',
      ],
    };

    for (const host of TOOL_HOST_IDS) {
      const missing = unknownBoundToolNames(fixtures[host]);
      assert.deepEqual(
        missing,
        [],
        `${host} fixture names missing from catalog: ${missing.join(', ')}`,
      );
    }
  });
});
