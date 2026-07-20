import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import {
  FIXED_PROMPT_WAL_SCHEMA_VERSION as CONTROLLER_SCHEMA_VERSION,
  PROMPT_CANDIDATE_FAILURE_PATTERNS as CONTROLLER_FAILURE_PATTERNS,
  type FixedPromptWalEvent as ControllerWalEvent,
} from '../fixed-prompt-controller.js';
import {
  FIXED_PROMPT_WAL_SCHEMA_VERSION,
  PROMPT_CANDIDATE_FAILURE_PATTERNS,
  type FixedPromptWalEvent,
} from '../fixed-prompt-wal-types.js';

const REPO_ROOT = resolveRepoRoot();

async function readRepo(path: string): Promise<string> {
  return readFile(join(REPO_ROOT, path), 'utf8');
}

function resolveRepoRoot(): string {
  const cwd = resolve(process.cwd());
  if (existsSync(join(cwd, 'packages', 'headless', 'src', 'fixed-prompt-controller.ts')))
    return cwd;
  const fromWorkspace = resolve(cwd, '..', '..');
  if (existsSync(join(fromWorkspace, 'packages', 'headless', 'src', 'fixed-prompt-controller.ts')))
    return fromWorkspace;
  return cwd;
}

function acceptsWalEvent(_event: FixedPromptWalEvent): void {}

describe('Fixed prompt WAL types extraction contract', () => {
  test('the controller preserves its existing WAL exports', () => {
    assert.equal(CONTROLLER_SCHEMA_VERSION, FIXED_PROMPT_WAL_SCHEMA_VERSION);
    assert.strictEqual(CONTROLLER_FAILURE_PATTERNS, PROMPT_CANDIDATE_FAILURE_PATTERNS);

    const acceptsControllerEvent: (event: ControllerWalEvent) => void = acceptsWalEvent;
    assert.equal(typeof acceptsControllerEvent, 'function');
  });

  test('the WAL schema lives in a leaf with no controller or Node dependency', async () => {
    const schema = await readRepo('packages/headless/src/fixed-prompt-wal-types.ts');

    assert.match(schema, /export const FIXED_PROMPT_WAL_SCHEMA_VERSION = 1;/);
    assert.match(schema, /export interface FixedPromptTaskCompletedEvent/);
    assert.match(schema, /export interface FixedPromptTaskBudgetExhaustedEvent/);
    assert.match(schema, /export interface PromptCandidateDecisionEvent/);
    assert.match(schema, /export interface RsiControllerAttributionEvent/);
    assert.match(schema, /export type FixedPromptWalEvent =/);
    assert.match(schema, /export type FixedPromptTaskWalEvent =/);
    assert.doesNotMatch(schema, /from '\.\/fixed-prompt-controller\.js'/);
    assert.doesNotMatch(schema, /from 'node:/);
  });

  test('the controller imports the schema instead of redeclaring it', async () => {
    const controller = await readRepo('packages/headless/src/fixed-prompt-controller.ts');

    assert.match(controller, /from '\.\/fixed-prompt-wal-types\.js'/);
    assert.doesNotMatch(controller, /export const FIXED_PROMPT_WAL_SCHEMA_VERSION =/);
    assert.doesNotMatch(controller, /export interface FixedPromptTaskCompletedEvent/);
    assert.doesNotMatch(controller, /export interface PromptCandidateDecisionEvent/);
    assert.doesNotMatch(controller, /export interface RsiControllerAttributionEvent/);
    assert.doesNotMatch(controller, /export type FixedPromptWalEvent =/);
    assert.doesNotMatch(controller, /export type FixedPromptTaskWalEvent =/);
  });

  test('package-local schema consumers depend directly on the WAL leaf', async () => {
    const consumers = await Promise.all(
      [
        'packages/headless/src/harbor-task-runner.ts',
        'packages/headless/src/prompt-candidate-loop.ts',
        'packages/headless/src/prompt-structural-smoke.ts',
        'packages/headless/src/rsi-controller-attribution.ts',
      ].map((path) => readRepo(path)),
    );

    for (const consumer of consumers) {
      assert.match(consumer, /from '\.\/fixed-prompt-wal-types\.js'/);
    }
  });
});
