import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../../');

// `desktop` reads the combined main-process source: the parent Agent tool
// builder and the deferred-group projection now live in tool-assembly.ts
// (arch R4), still part of the same main-process surface this contract locks.
describe('AgentSwarm host registration contract', () => {
  test('desktop, CLI, and headless use the same parent Agent tool builder', async () => {
    const [desktop, cli, headless] = await Promise.all([
      readMainProcessCombinedSource(),
      readFile(resolve(REPO_ROOT, 'packages/cli/src/runtime-bootstrap.ts'), 'utf8'),
      readFile(resolve(REPO_ROOT, 'packages/headless/src/tools.ts'), 'utf8'),
    ]);

    assert.match(
      desktop,
      /buildParentAgentTools\(\{\s*taskLedger: taskLedgerStore,\s*\}\)/,
    );
    assert.match(cli, /const subagentTools = agentGraphEnabled\s*\?\s*buildParentAgentTools\(\)/);
    assert.match(
      headless,
      /\.\.\.buildParentAgentTools\(\)/,
    );

    for (const source of [desktop, cli, headless]) {
      assert.doesNotMatch(
        source,
        /buildAgentSwarmTool\(/,
        'hosts must consume the shared parent tool surface instead of forking AgentSwarm',
      );
    }
  });

  test('all hosts derive deferred groups from the shared catalog', async () => {
    const [desktop, cli, headless, catalog] = await Promise.all([
      readMainProcessCombinedSource(),
      readFile(resolve(REPO_ROOT, 'packages/cli/src/runtime-bootstrap.ts'), 'utf8'),
      readFile(resolve(REPO_ROOT, 'packages/headless/src/tools.ts'), 'utf8'),
      readFile(resolve(REPO_ROOT, 'packages/core/src/tool-catalog.ts'), 'utf8'),
    ]);

    // Agent pack identity stays owned by the catalog (matches AGENT_TOOL_GROUP_ID).
    assert.match(catalog, /id:\s*'agent'/);
    assert.match(catalog, /toolNames:\s*\[[\s\S]*'agent_spawn'[\s\S]*'agent_swarm'/);

    assert.match(
      desktop,
      /projectEffectiveProductToolSurface\(\{[\s\S]*host:\s*'desktop'/,
    );
    assert.match(
      cli,
      /projectEffectiveProductToolSurface\(\{[\s\S]*host:\s*'cli'/,
    );
    assert.match(
      headless,
      /projectEffectiveProductToolSurface\(\{[\s\S]*host:\s*'headless'/,
    );

    for (const source of [desktop, cli, headless]) {
      assert.doesNotMatch(
        source,
        /buildSubagentToolGroup\(/,
        'hosts must project deferred groups from the catalog, not hand-list buildSubagentToolGroup',
      );
    }
  });
});
