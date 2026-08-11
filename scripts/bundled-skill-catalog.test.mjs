import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';

import { readBundledSkillSources } from './gen-bundled-skill-catalog.mjs';

const execFileAsync = promisify(execFile);

test('the generated Runtime Skill catalog matches its reviewable sources', async () => {
  await execFileAsync(process.execPath, ['scripts/gen-bundled-skill-catalog.mjs', '--check']);
});

test('every bundled Skill has exactly one provenance disposition', async () => {
  const provenance = JSON.parse(
    await readFile(
      new URL('../packages/runtime/resources/bundled-skills/provenance.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(provenance.schemaVersion, 1);

  const sourceIds = readBundledSkillSources().map((source) => source.id);
  const confirmedIds = provenance.records.map((record) => record.id);
  const unresolvedIds = provenance.unresolvedGroups.flatMap((group) => group.skillIds);
  const recordedIds = [...confirmedIds, ...unresolvedIds].sort((a, b) => a.localeCompare(b));

  assert.equal(new Set(recordedIds).size, recordedIds.length, 'duplicate provenance disposition');
  assert.deepEqual(recordedIds, sourceIds);
});

test('the Computer Use Skill carries the contributor-confirmed origin statement', async () => {
  const provenance = JSON.parse(
    await readFile(
      new URL('../packages/runtime/resources/bundled-skills/provenance.json', import.meta.url),
      'utf8',
    ),
  );
  const record = provenance.records.find((candidate) => candidate.id === 'computer-use');

  assert.equal(record?.status, 'contributor-confirmed');
  assert.equal(record?.origin, 'independently-authored');
  assert.equal(record?.author?.github, 'hqhq1025');
  assert.equal(record?.aiAssistance?.tool, 'OpenAI Codex');
  assert.equal(record?.thirdPartySkillBodiesUsed, false);
  assert.equal(record?.license, 'Apache-2.0');
  assert.equal(record?.introducedBy?.pullRequest, 2147);
  assert.equal(record?.review?.status, 'pending-independent-review');
});
