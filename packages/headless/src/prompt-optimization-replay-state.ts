import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { hashSystemPrompt } from './fixed-prompt-controller.js';
import type {
  FixedPromptTaskWalEvent,
  FixedPromptWalEvent,
  PromptCandidateCommittedEvent,
  PromptCandidateDecisionEvent,
} from './fixed-prompt-wal-types.js';
import { hashCandidateRationale } from './prompt-candidate-loop.js';
import { heldInTaskSetHash } from './rsi-round-analysis.js';

const execFileAsync = promisify(execFile);

export interface PromptOptimizationReplayState {
  seedCommitSha: string;
  lastKeptCommitSha: string;
  expectedPromptRepoHead: string;
  candidateByRoundId: ReadonlyMap<string, PromptCandidateCommittedEvent>;
  decisionByRoundId: ReadonlyMap<string, PromptCandidateDecisionEvent>;
}

export interface PromptOptimizationReplayPlan {
  state: PromptOptimizationReplayState;
  seedPromptHash: string;
  historicalBaselineEvidenceRequired: boolean;
}

export async function reconcilePromptRepoWithReplayState(input: {
  gitRootPath: string;
  expectedHead: string;
  programPath: string;
  systemPromptGitPath: string;
  recoverExpectedHeadFromParent?: boolean;
}): Promise<void> {
  let head = await gitOutput(input.gitRootPath, 'rev-parse', 'HEAD');
  if (head !== input.expectedHead) {
    if (
      input.recoverExpectedHeadFromParent &&
      (await commitParentMatchesHead(input.gitRootPath, input.expectedHead, head))
    ) {
      await git(input.gitRootPath, 'reset', '--hard', input.expectedHead);
      head = input.expectedHead;
    } else {
      throw new Error(
        `prompt repo HEAD does not match resumed RSI WAL state: expected ${input.expectedHead}, got ${head}`,
      );
    }
  }
  const programGitPath = await toGitRelativePath(input.gitRootPath, input.programPath);
  const promptGitPaths = [programGitPath, input.systemPromptGitPath];
  for (const path of [...new Set(promptGitPaths)]) {
    if (!(await gitExitZero(input.gitRootPath, 'ls-files', '--error-unmatch', '--', path))) {
      throw new Error(`prompt repo prompt file must be tracked before RSI run: ${path}`);
    }
  }
  const [worktreeClean, indexClean] = await Promise.all([
    gitExitZero(input.gitRootPath, 'diff', '--quiet', '--', ...promptGitPaths),
    gitExitZero(input.gitRootPath, 'diff', '--cached', '--quiet', '--', ...promptGitPaths),
  ]);
  if (!worktreeClean || !indexClean) {
    throw new Error(
      `prompt repo has uncommitted prompt file changes: ${promptGitPaths.join(', ')}`,
    );
  }
}

export function assertCandidateMatchesStableTaskSet(
  candidate: PromptCandidateCommittedEvent,
  stableHeldInTaskIds: readonly string[],
): void {
  assertCandidateEventSelfConsistent(candidate);
  const actualHash = heldInTaskSetHash(candidate.heldInTaskIds);
  const expectedHash = heldInTaskSetHash(stableHeldInTaskIds);
  if (candidate.heldInTaskSetHash !== actualHash || candidate.heldInTaskSetHash !== expectedHash) {
    throw new Error(`RSI WAL replay candidate task-set mismatch for ${candidate.roundId}`);
  }
}

export async function buildPromptOptimizationReplayPlan(input: {
  events: readonly FixedPromptWalEvent[];
  promptRepoDir: string;
  systemPromptGitPath: string;
  runId?: string;
  resumeFingerprint?: string;
  strictRoundState?: boolean;
}): Promise<PromptOptimizationReplayPlan> {
  if (input.runId) assertWalBelongsToRun(input.events, input.runId);
  const state = await derivePromptOptimizationReplayState({
    events: input.events,
    promptRepoDir: input.promptRepoDir,
    systemPromptGitPath: input.systemPromptGitPath,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.resumeFingerprint ? { resumeFingerprint: input.resumeFingerprint } : {}),
    ...(input.strictRoundState !== undefined ? { strictRoundState: input.strictRoundState } : {}),
  });
  return {
    state,
    seedPromptHash: await readSeedSystemPromptHash({
      promptRepoDir: input.promptRepoDir,
      seedCommitSha: state.seedCommitSha,
      systemPromptGitPath: input.systemPromptGitPath,
    }),
    historicalBaselineEvidenceRequired: hasHistoricalPromptOptimizationState(state),
  };
}

export function replayStateHasRecoverablePendingCandidateEvidence(input: {
  events: readonly FixedPromptWalEvent[];
  state: PromptOptimizationReplayState;
  runId?: string;
}): boolean {
  const recoverablePendingCandidate = [...input.state.candidateByRoundId.values()].find(
    (candidate) =>
      candidate.commitSha === input.state.expectedPromptRepoHead &&
      !input.state.decisionByRoundId.has(candidate.roundId),
  );
  return (
    recoverablePendingCandidate !== undefined &&
    input.events.some(
      (event) =>
        matchesRun(event, input.runId) &&
        event.roundId === recoverablePendingCandidate.roundId &&
        isTaskEvent(event),
    )
  );
}

export async function derivePromptOptimizationReplayState(input: {
  events: readonly FixedPromptWalEvent[];
  promptRepoDir: string;
  systemPromptGitPath?: string;
  runId?: string;
  resumeFingerprint?: string;
  strictRoundState?: boolean;
}): Promise<PromptOptimizationReplayState> {
  const seedCommitSha = await gitOutput(input.promptRepoDir, 'rev-list', '--max-parents=0', 'HEAD');
  let lastKeptCommitSha = seedCommitSha;
  let expectedPromptRepoHead = seedCommitSha;
  const candidateByRoundId = new Map<string, PromptCandidateCommittedEvent>();
  const decisionByRoundId = new Map<string, PromptCandidateDecisionEvent>();

  for (const event of input.events) {
    if (!matchesRun(event, input.runId)) continue;
    if (
      input.resumeFingerprint !== undefined &&
      isTaskEvent(event) &&
      event.resumeFingerprint !== input.resumeFingerprint
    ) {
      throw new Error(`RSI WAL replay identity mismatch for ${event.roundId}/${event.taskId}`);
    }
    if (isTaskEvent(event) && event.roundId.startsWith('round-')) {
      const candidate = candidateByRoundId.get(event.roundId);
      if (!candidate && input.strictRoundState) {
        throw new Error(
          `RSI WAL replay found task evidence before candidate commit for ${event.roundId}`,
        );
      }
      if (decisionByRoundId.has(event.roundId) && input.strictRoundState) {
        throw new Error(
          `RSI WAL replay found task evidence after decision for ${event.roundId}/${event.taskId}`,
        );
      }
      if (candidate && !taskEventMatchesPromptIdentity(event, candidate.promptHash)) {
        throw new Error(`RSI WAL replay prompt hash mismatch for ${event.roundId}/${event.taskId}`);
      }
    }
    if (event.type === 'prompt_candidate_committed') {
      if (candidateByRoundId.has(event.roundId)) {
        throw new Error(`RSI WAL replay found duplicate candidate commit for ${event.roundId}`);
      }
      if (input.strictRoundState) {
        assertCandidateEventSelfConsistent(event);
        assertCandidateRoundCanFollow(
          event.roundId,
          candidateByRoundId.size,
          decisionByRoundId.size,
        );
        await assertCandidateParentMatchesExpectedHead({
          candidate: event,
          promptRepoDir: input.promptRepoDir,
          expectedParentSha: expectedPromptRepoHead,
        });
        if (!input.systemPromptGitPath) {
          throw new Error('RSI WAL replay requires system prompt path for strict candidate replay');
        }
        await assertCandidateChangesOnlySystemPrompt({
          candidate: event,
          promptRepoDir: input.promptRepoDir,
          systemPromptGitPath: input.systemPromptGitPath,
        });
        await assertCandidatePromptHashMatchesCommit({
          candidate: event,
          promptRepoDir: input.promptRepoDir,
          systemPromptGitPath: input.systemPromptGitPath,
        });
      }
      candidateByRoundId.set(event.roundId, event);
      expectedPromptRepoHead = event.commitSha;
      continue;
    }
    if (event.type === 'prompt_candidate_decided') {
      if (decisionByRoundId.has(event.roundId)) {
        throw new Error(`RSI WAL replay found duplicate prompt decision for ${event.roundId}`);
      }
      const candidate = candidateByRoundId.get(event.roundId);
      if (!candidate && input.strictRoundState) {
        throw new Error(
          `RSI WAL replay found decision without candidate commit for ${event.roundId}`,
        );
      }
      if (candidate && candidate.commitSha !== event.candidateCommitSha) {
        throw new Error(`RSI WAL replay found decision candidate mismatch for ${event.roundId}`);
      }
      if (input.strictRoundState && event.previousLastKeptCommitSha !== lastKeptCommitSha) {
        throw new Error(`RSI WAL replay found stale previous last-kept for ${event.roundId}`);
      }
      const expectedLastKept =
        event.decision === 'keep' ? event.candidateCommitSha : event.previousLastKeptCommitSha;
      if (input.strictRoundState && event.lastKeptCommitSha !== expectedLastKept) {
        throw new Error(`RSI WAL replay found invalid last-kept for ${event.roundId}`);
      }
      if (input.strictRoundState && event.originalCommitSha !== seedCommitSha) {
        throw new Error(`RSI WAL replay found original commit mismatch for ${event.roundId}`);
      }
      decisionByRoundId.set(event.roundId, event);
      lastKeptCommitSha = event.lastKeptCommitSha;
      expectedPromptRepoHead = event.lastKeptCommitSha;
      continue;
    }
  }

  return {
    seedCommitSha,
    lastKeptCommitSha,
    expectedPromptRepoHead,
    candidateByRoundId,
    decisionByRoundId,
  };
}

function hasHistoricalPromptOptimizationState(state: PromptOptimizationReplayState): boolean {
  return (
    state.candidateByRoundId.size > 0 ||
    state.decisionByRoundId.size > 0 ||
    state.expectedPromptRepoHead !== state.seedCommitSha
  );
}

function assertWalBelongsToRun(events: readonly FixedPromptWalEvent[], runId: string): void {
  const otherRun = events.find((event) => event.runId !== runId);
  if (otherRun) {
    throw new Error(
      `RSI WAL replay found events for a different runId: expected ${runId}, got ${otherRun.runId}`,
    );
  }
}

function assertCandidateEventSelfConsistent(candidate: PromptCandidateCommittedEvent): void {
  if (candidate.heldInTaskSetHash !== heldInTaskSetHash(candidate.heldInTaskIds)) {
    throw new Error(`RSI WAL replay candidate task-set mismatch for ${candidate.roundId}`);
  }
  if (candidate.candidateRationaleHash !== hashCandidateRationale(candidate.candidateRationale)) {
    throw new Error(`RSI WAL replay candidate rationale mismatch for ${candidate.roundId}`);
  }
}

function assertCandidateRoundCanFollow(
  roundId: string,
  existingCandidateCount: number,
  existingDecisionCount: number,
): void {
  const roundIndex = roundIndexFromRoundId(roundId);
  if (roundIndex === undefined) {
    throw new Error(`RSI WAL replay found invalid candidate round id for ${roundId}`);
  }
  if (roundIndex !== existingCandidateCount || roundIndex !== existingDecisionCount) {
    throw new Error(`RSI WAL replay found candidate round gap for ${roundId}`);
  }
}

function roundIndexFromRoundId(roundId: string): number | undefined {
  const match = /^round-(\d+)$/.exec(roundId);
  if (!match) return undefined;
  return Number(match[1]);
}

async function assertCandidateParentMatchesExpectedHead(input: {
  candidate: PromptCandidateCommittedEvent;
  promptRepoDir: string;
  expectedParentSha: string;
}): Promise<void> {
  let parentSha: string;
  try {
    parentSha = await gitOutput(input.promptRepoDir, 'rev-parse', `${input.candidate.commitSha}^`);
  } catch {
    throw new Error(
      `RSI WAL replay found candidate parent mismatch for ${input.candidate.roundId}`,
    );
  }
  if (parentSha !== input.expectedParentSha) {
    throw new Error(
      `RSI WAL replay found candidate parent mismatch for ${input.candidate.roundId}`,
    );
  }
}

async function assertCandidatePromptHashMatchesCommit(input: {
  candidate: PromptCandidateCommittedEvent;
  promptRepoDir: string;
  systemPromptGitPath: string;
}): Promise<void> {
  let systemPrompt: string;
  try {
    systemPrompt = await gitBlob(
      input.promptRepoDir,
      `${input.candidate.commitSha}:${input.systemPromptGitPath}`,
    );
  } catch {
    throw new Error(`RSI WAL replay candidate prompt hash mismatch for ${input.candidate.roundId}`);
  }
  if (hashSystemPrompt(systemPrompt) !== input.candidate.promptHash) {
    throw new Error(`RSI WAL replay candidate prompt hash mismatch for ${input.candidate.roundId}`);
  }
}

async function assertCandidateChangesOnlySystemPrompt(input: {
  candidate: PromptCandidateCommittedEvent;
  promptRepoDir: string;
  systemPromptGitPath: string;
}): Promise<void> {
  let changedFiles: string[];
  try {
    const output = await gitOutput(
      input.promptRepoDir,
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      input.candidate.commitSha,
    );
    changedFiles = output === '' ? [] : output.split('\n');
  } catch {
    throw new Error(
      `RSI WAL replay candidate changed unexpected files for ${input.candidate.roundId}`,
    );
  }
  if (changedFiles.length !== 1 || changedFiles[0] !== input.systemPromptGitPath) {
    throw new Error(
      `RSI WAL replay candidate changed unexpected files for ${input.candidate.roundId}`,
    );
  }
}

async function readSeedSystemPromptHash(input: {
  promptRepoDir: string;
  seedCommitSha: string;
  systemPromptGitPath: string;
}): Promise<string> {
  const systemPrompt = await gitBlob(
    input.promptRepoDir,
    `${input.seedCommitSha}:${input.systemPromptGitPath}`,
  );
  return hashSystemPrompt(systemPrompt);
}

export function matchesRun(event: FixedPromptWalEvent, runId: string | undefined): boolean {
  return runId === undefined || event.runId === runId;
}

export function isTaskEvent(event: FixedPromptWalEvent): event is FixedPromptTaskWalEvent {
  return (
    event.type === 'task_completed' ||
    event.type === 'task_infra_failed' ||
    event.type === 'task_budget_exhausted' ||
    event.type === 'task_plumbing_failed'
  );
}

function promptHashForReplayIdentity(event: FixedPromptTaskWalEvent): string | undefined {
  if (event.type === 'task_completed') return event.promptHash;
  if (event.type === 'task_plumbing_failed') return event.promptHash ?? event.expectedPromptHash;
  if (event.type === 'task_budget_exhausted') return event.expectedPromptHash;
  return undefined;
}

export function taskEventMatchesPromptIdentity(
  event: FixedPromptTaskWalEvent,
  expectedPromptHash: string,
): boolean {
  if (event.type === 'task_infra_failed') return true;
  return promptHashForReplayIdentity(event) === expectedPromptHash;
}

export async function readPromptHashAtCommit(input: {
  promptRepoDir: string;
  commitSha: string;
  systemPromptGitPath: string;
}): Promise<string> {
  return hashSystemPrompt(
    await gitBlob(input.promptRepoDir, `${input.commitSha}:${input.systemPromptGitPath}`),
  );
}

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function gitBlob(cwd: string, refPath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['show', refPath], { cwd, encoding: 'utf8' });
  return stdout;
}

async function gitExitZero(cwd: string, ...args: string[]): Promise<boolean> {
  try {
    await execFileAsync('git', args, { cwd });
    return true;
  } catch {
    return false;
  }
}

async function toGitRelativePath(gitRootPath: string, filePath: string): Promise<string> {
  const [rootPath, absolutePath] = await Promise.all([
    realpath(gitRootPath),
    realpath(isAbsolute(filePath) ? filePath : resolve(gitRootPath, filePath)),
  ]);
  const gitPath = relative(rootPath, absolutePath).split('\\').join('/');
  if (gitPath === '' || gitPath === '..' || gitPath.startsWith('../')) {
    throw new Error(`prompt repo prompt file must stay inside git root: ${filePath}`);
  }
  return gitPath;
}

async function commitParentMatchesHead(
  cwd: string,
  commitSha: string,
  headSha: string,
): Promise<boolean> {
  try {
    return (await gitOutput(cwd, 'rev-parse', `${commitSha}^`)) === headSha;
  } catch {
    return false;
  }
}
