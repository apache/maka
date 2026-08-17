import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ModelFactsDocumentOwner } from '../model-facts-store.js';
import { cleanupRuntimePolicyDocumentTemps } from '../runtime-policy/document-io.js';

test('model facts persist and malformed documents fail closed with a bounded diagnostic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-model-facts-'));
  try {
    const owner = new ModelFactsDocumentOwner();
    assert.deepEqual((await owner.read(root)).overrides, {});
    await owner.replace(root, { 'openai:o4-mini': { contextWindow: 200_000 } });
    assert.equal((await owner.read(root)).overrides['openai:o4-mini']?.contextWindow, 200_000);
    await writeFile(join(root, 'model-facts.json'), '{not-json}', 'utf8');
    const result = await owner.readWithDiagnostics(root);
    assert.equal(result.diagnostic, 'malformed');
    assert.deepEqual(result.document.overrides, {});
    await writeFile(
      join(root, 'model-facts.json'),
      JSON.stringify({ schemaVersion: 1, overrides: { 'openai:o4-mini': { unknown: true } } }),
      'utf8',
    );
    assert.equal((await owner.readWithDiagnostics(root)).diagnostic, 'malformed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('model facts temporary writes are removed by runtime policy recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-model-facts-recovery-'));
  try {
    await writeFile(
      join(root, 'model-facts.json.00000000-0000-4000-8000-000000000000.tmp'),
      '{}',
      'utf8',
    );
    await cleanupRuntimePolicyDocumentTemps(root);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
