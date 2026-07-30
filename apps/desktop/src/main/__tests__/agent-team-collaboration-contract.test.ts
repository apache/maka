import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

// The lead/child team tool builders and the childAgentTools surface moved into
// tool-assembly.ts (arch R4); the expert-dispatch + agentTeam backend wiring
// now lives in the shared backend tool-surface resolver. Reading the combined
// main-process source keeps every
// assertion intact across both files.
describe('desktop agent-team collaboration wiring', () => {
  it('shares one durable mailbox/task ledger across lead and child tools', async () => {
    const main = await readMainProcessCombinedSource();

    assert.match(main, /const agentMailboxStore = createAgentMailboxStore\(workspaceRoot\)/);
    assert.match(
      main,
      /buildAgentTeamLeadTools\(\{[\s\S]*?mailbox: agentMailboxStore,[\s\S]*?taskLedger: taskLedgerStore/,
    );
    assert.match(
      main,
      /buildAgentTeamChildTools\(\{[\s\S]*?mailbox: agentMailboxStore,[\s\S]*?taskLedger: taskLedgerStore/,
    );
    assert.match(main, /const childAgentTools = buildChildAgentTools\([\s\S]*?\.\.\.agentTeamChildTools/);
    assert.match(
      main,
      /buildExpertDispatchToolForTeamId\(expertTeamId, \{[\s\S]*?taskLedger: deps\.taskLedgerStore/,
    );
    assert.match(main, /tools: expertDispatchTool[\s\S]*?\.\.\.deps\.agentTeamLeadTools/);
    assert.match(main, /agentTeam,/);
  });
});
