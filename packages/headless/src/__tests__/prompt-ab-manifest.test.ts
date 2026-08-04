import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { buildRunManifestFingerprint } from '../ab-manifest.js';
import { buildPromptAbRunManifest, ensurePromptAbRunManifest } from '../prompt-ab-manifest.js';
import type { PromptAbRunManifestInput } from '../prompt-ab-types.js';
import { sha256 } from './helpers/hash-fixture.js';
import { withDir } from './helpers/temp-dir.js';

describe('prompt A/B run manifest', () => {
  test('rejects a reused run id when resume-critical config changes', async () => {
    await withDir(async (dir) => {
      const manifestPath = join(dir, 'prompt-ab-manifest.json');
      const original = buildPromptAbRunManifest({
        baselinePromptHash: 'sha256:baseline',
        candidatePromptHash: 'sha256:candidate',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek/deepseek-v4-flash',
        taskBudgetSec: 30 * 60,
        harborTimeoutMs: 35 * 60 * 1000,
        subjectFingerprint: 'subject:path=/repo;maka-head=abc123;dirty=false',
        taskSourceFingerprint:
          'tasks:path=/cache/tasks;selected=task-a:/cache/tasks/a,task-b:/cache/tasks/b',
        toolchainFingerprint: sha256('c'),
        evaluationTaskIds: ['task-a', 'task-b'],
        reps: 3,
        candidateLimit: null,
        maxConcurrency: 16,
      });
      await ensurePromptAbRunManifest(manifestPath, original);
      assert.equal(
        (await ensurePromptAbRunManifest(manifestPath, original)).fingerprint,
        original.fingerprint,
      );

      await assert.rejects(
        ensurePromptAbRunManifest(
          manifestPath,
          buildPromptAbRunManifest({
            ...original,
            taskBudgetSec: 60 * 60,
          }),
        ),
        /prompt A\/B run manifest does not match existing run id/,
      );
      await assert.rejects(
        ensurePromptAbRunManifest(
          manifestPath,
          buildPromptAbRunManifest({
            ...original,
            subjectFingerprint: 'subject:path=/repo;maka-head=def456;dirty=false',
          }),
        ),
        /prompt A\/B run manifest does not match existing run id/,
      );
      await assert.rejects(
        ensurePromptAbRunManifest(
          manifestPath,
          buildPromptAbRunManifest({
            ...original,
            taskSourceFingerprint:
              'tasks:path=/other-cache/tasks;selected=task-a:/other-cache/tasks/a,task-b:/other-cache/tasks/b',
          }),
        ),
        /prompt A\/B run manifest does not match existing run id/,
      );
      await assert.rejects(
        ensurePromptAbRunManifest(
          manifestPath,
          buildPromptAbRunManifest({
            ...original,
            provider: 'openai',
            baseUrl: 'https://api.openai.com',
          }),
        ),
        /prompt A\/B run manifest does not match existing run id/,
      );
      await assert.rejects(
        ensurePromptAbRunManifest(
          manifestPath,
          buildPromptAbRunManifest({
            ...original,
            evaluationTaskIds: ['task-a', 'task-c'],
          }),
        ),
        /prompt A\/B run manifest does not match existing run id/,
      );
      await assert.rejects(
        ensurePromptAbRunManifest(
          manifestPath,
          buildPromptAbRunManifest({
            ...original,
            toolchainFingerprint: sha256('d'),
          }),
        ),
        /prompt A\/B run manifest does not match existing run id/,
      );
    });
  });

  test('resumes a prompt manifest written before the generic A/B core split', async () => {
    await withDir(async (dir) => {
      const manifestPath = join(dir, 'prompt-ab-manifest.json');
      const input = promptManifestInput();
      const legacyManifest = buildLegacyPromptAbRunManifest(input);
      await writeFile(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`, 'utf8');

      const current = buildPromptAbRunManifest(input);
      const resumed = await ensurePromptAbRunManifest(manifestPath, current);

      assert.equal(resumed.fingerprint, legacyManifest.fingerprint);
      assert.equal(resumed.experimentKind, 'prompt');
      assert.deepEqual(resumed.arms, current.arms);
      await assert.rejects(
        ensurePromptAbRunManifest(
          manifestPath,
          buildPromptAbRunManifest({
            ...input,
            taskBudgetSec: input.taskBudgetSec + 1,
          }),
        ),
        /prompt A\/B run manifest does not match existing run id/,
      );
      await assert.rejects(
        ensurePromptAbRunManifest(
          manifestPath,
          buildPromptAbRunManifest({
            ...input,
            subjectFingerprint: 'subject:path=/repo;maka-head=def456;dirty=false',
          }),
        ),
        /prompt A\/B run manifest does not match existing run id/,
      );
      await assert.rejects(
        ensurePromptAbRunManifest(
          manifestPath,
          buildPromptAbRunManifest({
            ...input,
            taskSourceFingerprint:
              'tasks:path=/other-cache/tasks;selected=task-a:/other-cache/tasks/a,task-b:/other-cache/tasks/b',
          }),
        ),
        /prompt A\/B run manifest does not match existing run id/,
      );
    });
  });
});

function promptManifestInput(): PromptAbRunManifestInput {
  return {
    baselinePromptHash: 'sha256:baseline',
    candidatePromptHash: 'sha256:candidate',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek/deepseek-v4-flash',
    taskBudgetSec: 30 * 60,
    harborTimeoutMs: 35 * 60 * 1000,
    subjectFingerprint: 'subject:path=/repo;maka-head=abc123;dirty=false',
    taskSourceFingerprint:
      'tasks:path=/cache/tasks;selected=task-a:/cache/tasks/a,task-b:/cache/tasks/b',
    toolchainFingerprint: sha256('c'),
    evaluationTaskIds: ['task-a', 'task-b'],
    reps: 3,
    candidateLimit: null,
    maxConcurrency: 16,
  };
}

type LegacyPromptAbRunManifest = PromptAbRunManifestInput & {
  schemaVersion: 'maka.prompt_ab.run_manifest.v1';
  fingerprint: string;
  evaluationTaskIds: string[];
  candidateTaskIds?: string[];
};

function buildLegacyPromptAbRunManifest(
  input: PromptAbRunManifestInput,
): LegacyPromptAbRunManifest {
  const manifestWithoutFingerprint = withoutUndefined({
    schemaVersion: 'maka.prompt_ab.run_manifest.v1' as const,
    baselinePromptHash: input.baselinePromptHash,
    candidatePromptHash: input.candidatePromptHash,
    provider: input.provider,
    baseUrl: input.baseUrl,
    model: input.model,
    taskBudgetSec: input.taskBudgetSec,
    harborTimeoutMs: input.harborTimeoutMs,
    subjectFingerprint: input.subjectFingerprint,
    taskSourceFingerprint: input.taskSourceFingerprint,
    toolchainFingerprint: input.toolchainFingerprint,
    evaluationTaskIds: [...input.evaluationTaskIds],
    reps: input.reps,
    candidateLimit: input.candidateLimit,
    maxConcurrency: input.maxConcurrency,
    selectionMode: input.selectionMode,
    candidateTaskIds: input.candidateTaskIds ? [...input.candidateTaskIds] : undefined,
    maxExpertTimeEstimateMin: input.maxExpertTimeEstimateMin,
    targetEvaluationTaskCount: input.targetEvaluationTaskCount,
  });
  return {
    ...manifestWithoutFingerprint,
    fingerprint: buildRunManifestFingerprint(manifestWithoutFingerprint),
  };
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}
