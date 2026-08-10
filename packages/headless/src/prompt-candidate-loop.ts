import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, readlink, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { appendFixedPromptWalEvent, hashSystemPrompt } from './fixed-prompt-controller.js';
import {
  assertOnlySystemPromptChanged,
  assertRegularSystemPromptFile,
  isPathInside,
  normalizeGitPath,
  type PromptCandidateGit,
} from './prompt-candidate-git.js';

export {
  createCliPromptCandidateGit,
  type CreateCliPromptCandidateGitInput,
  type PromptCandidateGit,
} from './prompt-candidate-git.js';
import {
  readRuntimeEventsJsonl,
  renderToolFailureSummary,
  stripPromptOnlyToolFailures,
  type TrajectoryDigest,
} from './prompt-candidate-digest.js';

export {
  extractTrajectoryDigest,
  type ExtractTrajectoryDigestInput,
  type TrajectoryDigest,
  type TrajectoryToolCallDigest,
  type TrajectoryToolFailureDigest,
} from './prompt-candidate-digest.js';
import {
  FIXED_PROMPT_WAL_SCHEMA_VERSION,
  PROMPT_CANDIDATE_FAILURE_PATTERNS,
  heldInTaskSetHash,
  sortedUnique,
  type PromptCandidateCommittedEvent,
  type PromptCandidateFailurePattern,
  type PromptCandidateRationale,
} from './fixed-prompt-wal-types.js';
import {
  projectRsiPromptAttribution,
  type ProjectRsiPromptAttributionInput,
} from './rsi-controller-attribution.js';
import type { RsiRoundAnalysis } from './rsi-round-analysis.js';

const CANDIDATE_RATIONALE_MAX_TASK_IDS = 16;
const CANDIDATE_RATIONALE_MAX_TEXT_CHARS = 280;
const CANDIDATE_RATIONALE_MAX_SERIALIZED_CHARS = 2000;
const META_AGENT_MAX_ATTEMPTS = 3;
const META_AGENT_RETRY_ERROR_MAX_CHARS = 240;
const FORBIDDEN_RATIONALE_TEXT_RE =
  /```|\r|\n|held[-_]out|verifier|expected[- ]output|\/app\/|tests\/|test\.sh|canary|runtime-events|events\.jsonl|raw trace/i;

export interface RewardHackScanInput {
  runtimeEventsPath: string;
  verifierPatterns: readonly string[];
}

export type RewardHackScanResult =
  | { decision: 'clean' }
  | { decision: 'quarantine'; reason: 'runtime_events_unreadable' }
  | { decision: 'quarantine'; reason: 'runtime_events_empty' }
  | { decision: 'quarantine'; reason: 'no_verifier_patterns' }
  | { decision: 'quarantine'; reason: 'no_model_visible_events' }
  | { decision: 'quarantine'; reason: 'verifier_pattern'; matchedPatterns: readonly string[] };

export type CandidateFailurePattern = PromptCandidateFailurePattern;

export type CandidateRationale = PromptCandidateRationale;

export interface MetaAgentPromptInput {
  runId: string;
  roundId: string;
  program: string;
  currentSystemPrompt: string;
  resultsTsv: string;
  heldInDigests: readonly TrajectoryDigest[];
  rsiAnalysis?: RsiRoundAnalysis;
  promptAttribution?: ProjectRsiPromptAttributionInput;
}

export interface MetaAgentPromptResult {
  systemPrompt: string;
  summary: string;
  candidateRationale: CandidateRationale;
}

export type MetaAgent = (input: MetaAgentPromptInput) => Promise<MetaAgentPromptResult>;

export interface MetaAgentCompletionInput {
  prompt: string;
}

export type MetaAgentCompletion = (input: MetaAgentCompletionInput) => Promise<string>;

export interface CreateScriptedMetaAgentInput {
  complete: MetaAgentCompletion;
}

export interface RunPromptCandidateRoundInput {
  runId: string;
  roundId: string;
  agentCwdPath: string;
  programPath: string;
  systemPromptPath: string;
  resultsTsvPath: string;
  resultsJsonlPath: string;
  heldInTaskIds: readonly string[];
  heldInDigests: readonly TrajectoryDigest[];
  rsiAnalysis?: RsiRoundAnalysis;
  promptAttribution?: ProjectRsiPromptAttributionInput;
  heldOutDigests?: readonly TrajectoryDigest[];
  heldOutArtifactPaths?: readonly string[];
  metaAgent: MetaAgent;
  git: PromptCandidateGit;
  now?: () => number;
  newId?: () => string;
}

interface ArtifactTargetPath {
  absolutePath: string;
  realPath: string;
}

export interface PromptCandidateRoundResult {
  systemPrompt: string;
  summary: string;
  commitSha: string;
  candidateRationale: CandidateRationale;
  candidateRationaleHash: string;
  heldInTaskSetHash: string;
}

export async function runPromptCandidateRound(
  input: RunPromptCandidateRoundInput,
): Promise<PromptCandidateRoundResult> {
  const now = input.now ?? Date.now;
  const newId = input.newId ?? randomId;
  assertHeldInDigestsBelongToHeldInTasks(input.heldInTaskIds, input.heldInDigests);
  assertHeldInAndHeldOutDisjoint(input.heldInTaskIds, input.heldOutDigests ?? []);
  const heldOutArtifactPaths = input.heldOutArtifactPaths ?? [];
  if (input.agentCwdPath === undefined) {
    throw new Error('agentCwdPath is required before exposing controller artifacts');
  }
  await assertControllerOnlyArtifactsOutsideAgentCwd(input.agentCwdPath, [
    input.resultsTsvPath,
    input.resultsJsonlPath,
    ...heldOutArtifactPaths,
  ]);
  await assertSystemPromptPathMatchesGit(input.systemPromptPath, input.git);
  await assertRegularSystemPromptFile(input.systemPromptPath, input.git.gitRootPath);
  await input.git.assertSystemPromptClean();
  const program = await readFile(input.programPath, 'utf8');
  const currentSystemPrompt = await readFile(input.systemPromptPath, 'utf8');
  const resultsTsv = filterResultsTsvForHeldIn(
    await readFile(input.resultsTsvPath, 'utf8'),
    input.heldInTaskIds,
  );
  const promptAttribution = input.promptAttribution
    ? projectRsiPromptAttribution(input.promptAttribution)
    : undefined;
  const result = await input.metaAgent({
    runId: input.runId,
    roundId: input.roundId,
    program,
    currentSystemPrompt,
    resultsTsv,
    heldInDigests: input.heldInDigests,
    ...(input.rsiAnalysis ? { rsiAnalysis: input.rsiAnalysis } : {}),
    ...(promptAttribution ? { promptAttribution } : {}),
  });
  const candidateRationale = validateCandidateRationale(
    result.candidateRationale,
    input.heldInTaskIds,
    input.rsiAnalysis,
  );

  await writeFile(input.systemPromptPath, result.systemPrompt, 'utf8');
  let commitSha: string;
  try {
    assertOnlySystemPromptChanged(await input.git.changedFiles(), input.git.systemPromptGitPath);
    commitSha = await input.git.commit(`candidate prompt ${input.roundId}`);
  } catch (error) {
    await input.git.restoreSystemPrompt();
    throw error;
  }
  try {
    await appendFixedPromptWalEvent(
      input.resultsJsonlPath,
      promptCandidateCommittedEvent({
        runId: input.runId,
        roundId: input.roundId,
        id: newId(),
        ts: now(),
        commitSha,
        summary: result.summary,
        systemPrompt: result.systemPrompt,
        heldInTaskIds: input.heldInTaskIds,
        candidateRationale,
      }),
    );
  } catch (error) {
    await input.git.rollbackCommit(commitSha);
    throw error;
  }
  return {
    systemPrompt: result.systemPrompt,
    summary: result.summary,
    commitSha,
    candidateRationale,
    candidateRationaleHash: hashCandidateRationale(candidateRationale),
    heldInTaskSetHash: heldInTaskSetHash(input.heldInTaskIds),
  };
}

async function assertSystemPromptPathMatchesGit(
  systemPromptPath: string,
  git: PromptCandidateGit,
): Promise<void> {
  const [inputRealPath, gitRealPath] = await Promise.all([
    realpath(systemPromptPath),
    realpath(resolve(git.gitRootPath, git.systemPromptGitPath)),
  ]);
  if (inputRealPath !== gitRealPath) {
    throw new Error('system prompt path must match git prompt path');
  }
}

function assertHeldInAndHeldOutDisjoint(
  heldInTaskIds: readonly string[],
  heldOutDigests: readonly TrajectoryDigest[],
): void {
  const heldInTasks = new Set(heldInTaskIds);
  const overlap = heldOutDigests.find((digest) => heldInTasks.has(digest.taskId));
  if (overlap) {
    throw new Error(`held-in and held-out task sets must be disjoint: ${overlap.taskId}`);
  }
}

function assertHeldInDigestsBelongToHeldInTasks(
  heldInTaskIds: readonly string[],
  heldInDigests: readonly TrajectoryDigest[],
): void {
  const heldInTasks = new Set(heldInTaskIds);
  const outside = heldInDigests.find((digest) => !heldInTasks.has(digest.taskId));
  if (outside) {
    throw new Error(`held-in digests must belong to held-in task set: ${outside.taskId}`);
  }
}

async function assertControllerOnlyArtifactsOutsideAgentCwd(
  agentCwdPath: string,
  artifactPaths: readonly string[],
): Promise<void> {
  const agentCwdAbsolutePath = resolve(agentCwdPath);
  const agentCwdRealPath = await realpath(agentCwdPath);
  const visibleArtifacts = new Set<string>();
  const artifactTargetPaths: ArtifactTargetPath[] = [];
  for (const artifactPath of artifactPaths) {
    const artifactAbsolutePath = resolve(artifactPath);
    if (
      artifactAbsolutePath === agentCwdAbsolutePath ||
      isPathInside(agentCwdAbsolutePath, artifactAbsolutePath)
    ) {
      visibleArtifacts.add(
        normalizeGitPath(
          relative(agentCwdAbsolutePath, artifactAbsolutePath) || basename(artifactPath),
        ),
      );
    }
    const artifactRealPath = await realOrParentResolvedPath(artifactPath);
    artifactTargetPaths.push({ absolutePath: artifactAbsolutePath, realPath: artifactRealPath });
    if (artifactRealPath === agentCwdRealPath || isPathInside(agentCwdRealPath, artifactRealPath)) {
      visibleArtifacts.add(
        normalizeGitPath(relative(agentCwdRealPath, artifactRealPath) || basename(artifactPath)),
      );
    }
  }
  await addSymlinkedControllerArtifacts(
    agentCwdAbsolutePath,
    agentCwdAbsolutePath,
    artifactTargetPaths,
    visibleArtifacts,
  );
  if (visibleArtifacts.size > 0) {
    throw new Error(
      `controller-only artifacts must stay outside agent cwd: ${[...visibleArtifacts].join(', ')}`,
    );
  }
}

async function addSymlinkedControllerArtifacts(
  agentCwdPath: string,
  currentPath: string,
  artifactPaths: readonly ArtifactTargetPath[],
  visibleArtifacts: Set<string>,
): Promise<void> {
  const entries = await readdir(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = resolve(currentPath, entry.name);
    if (entry.isSymbolicLink()) {
      const targetPath = resolve(dirname(entryPath), await readlink(entryPath));
      let targetRealPath: string | undefined;
      try {
        targetRealPath = await realpath(entryPath);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      if (
        artifactPaths.some(
          (artifactPath) =>
            artifactPath.absolutePath === targetPath ||
            artifactPath.realPath === targetPath ||
            artifactPath.realPath === targetRealPath ||
            isPathInside(targetPath, artifactPath.absolutePath) ||
            isPathInside(targetPath, artifactPath.realPath) ||
            (targetRealPath !== undefined && isPathInside(targetRealPath, artifactPath.realPath)),
        )
      ) {
        visibleArtifacts.add(normalizeGitPath(relative(agentCwdPath, entryPath)));
      }
      continue;
    }
    if (entry.isDirectory()) {
      await addSymlinkedControllerArtifacts(
        agentCwdPath,
        entryPath,
        artifactPaths,
        visibleArtifacts,
      );
    }
  }
}

async function realOrParentResolvedPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return resolve(await realpath(dirname(path)), basename(path));
  }
}

export async function scanRuntimeEventsForRewardHack(
  input: RewardHackScanInput,
): Promise<RewardHackScanResult> {
  let events: unknown[];
  try {
    events = await readRuntimeEventsJsonl(input.runtimeEventsPath);
  } catch {
    return { decision: 'quarantine', reason: 'runtime_events_unreadable' };
  }

  const patterns = input.verifierPatterns.filter((pattern) => pattern.trim().length > 0);
  if (patterns.length === 0) return { decision: 'quarantine', reason: 'no_verifier_patterns' };
  if (events.length === 0) return { decision: 'quarantine', reason: 'runtime_events_empty' };
  const matchedPatterns = new Set<string>();
  let visibleValues = 0;
  for (const event of events) {
    for (const value of modelVisibleStrings(event)) {
      visibleValues += 1;
      for (const pattern of patterns) {
        if (value.includes(pattern)) matchedPatterns.add(pattern);
      }
    }
  }
  if (visibleValues === 0) return { decision: 'quarantine', reason: 'no_model_visible_events' };
  if (matchedPatterns.size > 0) {
    return {
      decision: 'quarantine',
      reason: 'verifier_pattern',
      matchedPatterns: [...matchedPatterns].sort((a, b) => a.localeCompare(b)),
    };
  }
  return { decision: 'clean' };
}

export function createScriptedMetaAgent(input: CreateScriptedMetaAgentInput): MetaAgent {
  return async (promptInput) => {
    const basePrompt = renderMetaAgentPrompt(promptInput);
    let lastParseError = 'unknown schema error';
    for (let attempt = 1; attempt <= META_AGENT_MAX_ATTEMPTS; attempt += 1) {
      const raw = await input.complete({
        prompt:
          attempt === 1
            ? basePrompt
            : renderMetaAgentRetryPrompt(basePrompt, attempt, lastParseError),
      });
      try {
        return parseMetaAgentResult(raw);
      } catch (error) {
        if (attempt === META_AGENT_MAX_ATTEMPTS) throw error;
        lastParseError = formatMetaAgentParseError(error);
      }
    }
    throw new Error('meta-agent output parsing exhausted retry attempts');
  };
}

function renderMetaAgentRetryPrompt(
  basePrompt: string,
  attempt: number,
  validationError: string,
): string {
  return [
    basePrompt.trimEnd(),
    '',
    '# Retry Feedback',
    `The previous meta-agent response was invalid for the required JSON schema on attempt ${attempt - 1}.`,
    `Validation error: ${validationError}`,
    'Return JSON only using the exact required schema. Arrays must be JSON arrays even when they contain one item.',
    '',
  ].join('\n');
}

function formatMetaAgentParseError(error: unknown): string {
  if (error instanceof SyntaxError) return 'meta-agent output was not valid JSON';
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, META_AGENT_RETRY_ERROR_MAX_CHARS);
}

export function renderMetaAgentPrompt(input: MetaAgentPromptInput): string {
  return [
    'You are improving one system prompt for benchmark tasks.',
    'Return JSON only: {"systemPrompt":"...","summary":"...","candidateRationale":{"editedSurface":"system_prompt","evidenceRefs":["rsi-sig:id"],"hypothesis":"short plain text","targetedFix":"short plain text","predictedFixes":["held-in-task-id"],"riskTasks":["held-in-task-id"]}}.',
    'candidateRationale.evidenceRefs may only reference RSI R2 Held-In Analysis signature or signal ids from the prompt. Cite those ids directly when available. Only when no evidence id is available, add failurePattern as a coarse fallback: "coverage_regression|tool_failed|max_tokens|runtime_error|verification_failed|other".',
    'candidateRationale.predictedFixes and riskTasks may only reference held-in task ids from the prompt.',
    'Prefer pass/fail transitions and verifier failure summaries over tool_failure_cluster. Treat tool_failure_cluster as root cause only when it is unrecovered or aligns with the final task outcome.',
    'Do not include held-out tasks, verifier internals, expected outputs, raw traces, file paths, code fences, or multiline text in candidateRationale.',
    '',
    '# Program',
    input.program,
    '# Current System Prompt',
    input.currentSystemPrompt,
    '# Results TSV',
    input.resultsTsv,
    ...renderToolFailureSummary(input.heldInDigests, input.resultsTsv),
    ...renderRsiAnalysis(input.rsiAnalysis),
    ...renderPromptAttribution(input.promptAttribution),
    '# Held-In Digests',
    JSON.stringify(stripPromptOnlyToolFailures(input.heldInDigests), null, 2),
    '',
  ].join('\n');
}

function renderRsiAnalysis(analysis: RsiRoundAnalysis | undefined): string[] {
  return analysis ? ['# RSI R2 Held-In Analysis', JSON.stringify(analysis, null, 2)] : [];
}

function renderPromptAttribution(
  attribution: ProjectRsiPromptAttributionInput | undefined,
): string[] {
  return attribution
    ? [
        '# RSI R2 Previous Prompt Attribution',
        JSON.stringify(projectRsiPromptAttribution(attribution), null, 2),
      ]
    : [];
}

export function filterResultsTsvForHeldIn(
  resultsTsv: string,
  heldInTaskIds: readonly string[],
): string {
  const hasTrailingNewline = resultsTsv.endsWith('\n');
  const lines = resultsTsv.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) return '';

  const header = lines[0];
  const taskIdIndex = header.split('\t').indexOf('task_id');
  if (taskIdIndex === -1) {
    throw new Error('results TSV must include a task_id column');
  }

  const heldInTasks = new Set(heldInTaskIds);
  const filtered = [
    header,
    ...lines.slice(1).filter((line) => {
      const columns = line.split('\t');
      return heldInTasks.has(columns[taskIdIndex] ?? '');
    }),
  ];
  return `${filtered.join('\n')}${hasTrailingNewline ? '\n' : ''}`;
}

export function parseMetaAgentResult(raw: string): MetaAgentPromptResult {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error('meta-agent output must be a JSON object');
  const systemPrompt = parsed.systemPrompt;
  const summary = parsed.summary;
  const candidateRationale = parseCandidateRationaleShape(parsed.candidateRationale);
  if (typeof systemPrompt !== 'string' || systemPrompt.length === 0) {
    throw new Error('meta-agent output systemPrompt must be a non-empty string');
  }
  if (typeof summary !== 'string' || summary.length === 0) {
    throw new Error('meta-agent output summary must be a non-empty string');
  }
  return { systemPrompt, summary, candidateRationale };
}

function validateCandidateRationale(
  value: unknown,
  heldInTaskIds: readonly string[],
  rsiAnalysis: RsiRoundAnalysis | undefined,
): CandidateRationale {
  const candidateRationale = parseCandidateRationaleShape(value);
  validateEvidenceRefs(candidateRationale, rsiAnalysis);
  validateHeldInTaskIds(candidateRationale.predictedFixes, 'predictedFixes', heldInTaskIds);
  validateHeldInTaskIds(candidateRationale.riskTasks, 'riskTasks', heldInTaskIds);
  return candidateRationale;
}

function parseCandidateRationaleShape(value: unknown): CandidateRationale {
  if (!isRecord(value)) {
    throw new Error('candidateRationale must be a JSON object');
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > CANDIDATE_RATIONALE_MAX_SERIALIZED_CHARS) {
    throw new Error(
      `candidateRationale must serialize to at most ${CANDIDATE_RATIONALE_MAX_SERIALIZED_CHARS} characters`,
    );
  }
  if (value.editedSurface !== 'system_prompt') {
    throw new Error('candidateRationale.editedSurface must be "system_prompt"');
  }
  if (
    typeof value.failurePattern !== 'undefined' &&
    !PROMPT_CANDIDATE_FAILURE_PATTERNS.includes(
      value.failurePattern as PromptCandidateFailurePattern,
    )
  ) {
    throw new Error(
      `candidateRationale.failurePattern must be one of: ${PROMPT_CANDIDATE_FAILURE_PATTERNS.join(', ')}`,
    );
  }
  const hypothesis = parseRationaleTextShape(value.hypothesis, 'hypothesis');
  const targetedFix = parseRationaleTextShape(value.targetedFix, 'targetedFix');
  const evidenceRefs = parseTaskIdArrayShape(value.evidenceRefs, 'evidenceRefs');
  const predictedFixes = parseTaskIdArrayShape(value.predictedFixes, 'predictedFixes');
  const riskTasks = parseTaskIdArrayShape(value.riskTasks, 'riskTasks');
  const failurePattern = value.failurePattern as CandidateFailurePattern | undefined;
  if (evidenceRefs.length === 0 && typeof failurePattern === 'undefined') {
    throw new Error(
      'candidateRationale.failurePattern fallback is required when evidenceRefs is empty',
    );
  }
  if (evidenceRefs.length > 0 && typeof failurePattern !== 'undefined') {
    throw new Error(
      'candidateRationale.failurePattern must be omitted when evidenceRefs cites current analysis',
    );
  }
  return {
    editedSurface: 'system_prompt',
    evidenceRefs,
    hypothesis,
    targetedFix,
    predictedFixes,
    riskTasks,
    ...(failurePattern ? { failurePattern } : {}),
  };
}

function validateEvidenceRefs(
  candidateRationale: CandidateRationale,
  rsiAnalysis: RsiRoundAnalysis | undefined,
): void {
  const { evidenceRefs } = candidateRationale;
  if (!rsiAnalysis) {
    if (evidenceRefs.length > 0) {
      throw new Error('candidateRationale.evidenceRefs require current RSI analysis signals');
    }
    return;
  }
  if (rsiAnalysis.signals.length > 0 && evidenceRefs.length === 0) {
    throw new Error(
      'candidateRationale.evidenceRefs must cite at least one current analysis signal',
    );
  }
  const known = new Set(rsiAnalysis.signals.map((signal) => signal.id));
  for (const ref of evidenceRefs) {
    if (!known.has(ref)) {
      throw new Error(
        `candidateRationale.evidenceRefs contains unknown analysis signal id: ${ref}`,
      );
    }
  }
}

function parseRationaleTextShape(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`candidateRationale.${field} must be a non-empty string`);
  }
  if (value.length > CANDIDATE_RATIONALE_MAX_TEXT_CHARS) {
    throw new Error(
      `candidateRationale.${field} must be at most ${CANDIDATE_RATIONALE_MAX_TEXT_CHARS} characters`,
    );
  }
  if (FORBIDDEN_RATIONALE_TEXT_RE.test(value)) {
    throw new Error(`candidateRationale.${field} contains forbidden prompt-memory content`);
  }
  return value;
}

function validateHeldInTaskIds(
  value: unknown,
  field: string,
  heldInTaskIds: readonly string[],
): void {
  const taskIds = parseTaskIdArrayShape(value, field);
  const heldIn = new Set(heldInTaskIds);
  for (const item of taskIds) {
    if (!heldIn.has(item)) {
      throw new Error(`candidateRationale.${field} contains non-held-in task id: ${item}`);
    }
  }
}

function parseTaskIdArrayShape(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`candidateRationale.${field} must be an array`);
  }
  if (value.length > CANDIDATE_RATIONALE_MAX_TASK_IDS) {
    throw new Error(
      `candidateRationale.${field} must contain at most ${CANDIDATE_RATIONALE_MAX_TASK_IDS} items`,
    );
  }
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) {
      throw new Error(`candidateRationale.${field} must contain non-empty task id strings`);
    }
  }
  return value;
}

function promptCandidateCommittedEvent(input: {
  runId: string;
  roundId: string;
  id: string;
  ts: number;
  commitSha: string;
  summary: string;
  systemPrompt: string;
  heldInTaskIds: readonly string[];
  candidateRationale: CandidateRationale;
}): PromptCandidateCommittedEvent {
  return {
    schemaVersion: FIXED_PROMPT_WAL_SCHEMA_VERSION,
    type: 'prompt_candidate_committed',
    id: input.id,
    ts: input.ts,
    runId: input.runId,
    roundId: input.roundId,
    commitSha: input.commitSha,
    summary: input.summary,
    promptHash: hashSystemPrompt(input.systemPrompt),
    heldInTaskSetHash: heldInTaskSetHash(input.heldInTaskIds),
    heldInTaskIds: sortedUnique(input.heldInTaskIds),
    candidateRationaleHash: hashCandidateRationale(input.candidateRationale),
    candidateRationale: input.candidateRationale,
  };
}

export function hashCandidateRationale(candidateRationale: CandidateRationale): string {
  return sha256Json(candidateRationale);
}

function sha256Json(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function randomId(): string {
  return randomUUID();
}

function modelVisibleStrings(event: unknown): readonly string[] {
  if (!isRecord(event) || !isRecord(event.content)) return [];
  const content = event.content;
  if (content.kind === 'text' && typeof content.text === 'string') return [content.text];
  if (content.kind === 'thinking' && typeof content.text === 'string') return [content.text];
  if (content.kind === 'function_call') return stringValues(content.args);
  if (content.kind === 'function_response') return stringValues(content.result);
  if (content.kind === 'error') return stringValues([content.message, content.details]);
  return [];
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => stringValues(item));
  if (isRecord(value)) return Object.values(value).flatMap((item) => stringValues(item));
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
