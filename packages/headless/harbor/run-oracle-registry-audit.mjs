#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  discoverCachedHarborTasks,
  fingerprintFixedPromptTaskTree,
} from '#fixed-prompt-task-source';
import { createHarborOracleQualifier, HarborInfraError } from '#harbor-task-runner';
import {
  buildHarnessOracleExecutionPolicyFingerprint,
  HARBOR_ORACLE_EXECUTION_POLICY,
  HARBOR_ORACLE_DOCKER_PLATFORM,
} from '#harness-oracle-policy';
import {
  auditHarnessOracleRegistry,
  buildHarnessOracleAuditTasks,
  buildHarnessOracleRegistrySnapshot,
  fingerprintHarnessOracleDocument,
  HarnessOracleAuditExecutionError,
  parseHarnessOracleRegistrySnapshot,
  pinHarnessOracleTaskEnvironment,
  planHarnessOracleRegistryAudit,
} from '#harness-oracle-registry';
import { assertFrozenTaskSet, assertFrozenTaskTreeFingerprint } from '#harness-ab-manifest';
import { TERMINAL_BENCH_2_1 } from './benchmark-identity.mjs';
import { resolveHarnessOracleBaseImageDigest } from './run-harness-ab.mjs';

const AUDIT_PLAN_SCHEMA_VERSION = 1;
const DOCKER_PLATFORM = HARBOR_ORACLE_DOCKER_PLATFORM;
const execFileAsync = promisify(execFile);

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rawArgs] = argv;
  const args = parseArgs(rawArgs);
  if (command === 'plan') return planCommand(args);
  if (command === 'task') return taskCommand(args);
  if (command === 'merge') return mergeCommand(args);
  throw new Error('usage: run-oracle-registry-audit.mjs <plan|task|merge> [--name value]');
}

async function planCommand(args) {
  const repoRoot = repoRootFromArgs(args);
  const tasksRoot = requiredArg(args, 'tasks-root');
  const tasks = await discoverCachedHarborTasks(tasksRoot);
  assertFrozenTaskSet(
    'Terminal-Bench 2.1',
    TERMINAL_BENCH_2_1.taskIds,
    tasks.map((task) => task.id),
  );
  assertFrozenTaskTreeFingerprint(
    'Terminal-Bench 2.1',
    TERMINAL_BENCH_2_1.taskTreeFingerprint,
    await fingerprintFixedPromptTaskTree(tasks),
  );
  const auditTasks = await currentAuditTasks(repoRoot, tasks);
  const previous = args.previous ? await readSnapshot(args.previous) : null;
  const plan = planHarnessOracleRegistryAudit(auditTasks, previous);
  const document = withFingerprint({
    schemaVersion: AUDIT_PLAN_SCHEMA_VERSION,
    tasks: auditTasks.map(({ task, identity }) => ({ taskId: task.id, identity })),
    reusedEntries: plan.reusedEntries,
  });
  await writeJson(requiredArg(args, 'out'), document);
  await writeJson(requiredArg(args, 'matrix-out'), {
    include: plan.missingTaskIds.map((taskId) => ({ task_id: taskId })),
  });
}

async function taskCommand(args) {
  const repoRoot = repoRootFromArgs(args);
  const plan = await readPlan(requiredArg(args, 'plan'));
  const taskId = requiredArg(args, 'task-id');
  const planned = plan.tasks.find((task) => task.taskId === taskId);
  if (!planned) throw new Error(`Oracle audit plan has no task ${taskId}`);
  const tasks = await discoverCachedHarborTasks(requiredArg(args, 'tasks-root'), new Set([taskId]));
  if (tasks.length !== 1)
    throw new Error(`Oracle audit expected exactly one task source for ${taskId}`);
  const [auditTask] = await currentAuditTasks(repoRoot, tasks);
  if (
    !auditTask ||
    fingerprintHarnessOracleDocument(auditTask.identity) !==
      fingerprintHarnessOracleDocument(planned.identity)
  ) {
    throw new Error(`Oracle audit identity changed after planning for task ${taskId}`);
  }
  if (!auditTask.resolvedEnvironment) {
    throw new Error(`Oracle audit resolved no execution environment for task ${taskId}`);
  }
  const jobsDir = requiredArg(args, 'jobs-dir');
  const pinnedTask = await pinHarnessOracleTaskEnvironment(
    auditTask.task,
    auditTask.resolvedEnvironment.baseImages,
    join(jobsDir, 'pinned-tasks'),
  );
  const qualifier = createHarborOracleQualifier({
    makaRepoPath: repoRoot,
    jobsDir,
  });
  const audit = await auditHarnessOracleRegistry({
    tasks: [{ ...auditTask, task: pinnedTask }],
    provenance: await workflowExecutionProvenance(),
    runOracle: async (task) => {
      try {
        return await qualifier(task);
      } catch (error) {
        if (error instanceof HarborInfraError) {
          throw new HarnessOracleAuditExecutionError(error.kind);
        }
        throw error;
      }
    },
  });
  await writeJson(requiredArg(args, 'out'), audit.snapshot.entries[0]);
}

async function mergeCommand(args) {
  const plan = await readPlan(requiredArg(args, 'plan'));
  const partialEntries = args['entries-dir']
    ? await readJsonFilesRecursively(args['entries-dir'])
    : [];
  const snapshot = buildHarnessOracleRegistrySnapshot({
    tasks: plan.tasks,
    entries: [...plan.reusedEntries, ...partialEntries],
    provenance: workflowProvenance(),
  });
  await writeJson(requiredArg(args, 'out'), snapshot);
  const evidencePath = requiredArg(args, 'evidence-out');
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(
    evidencePath,
    snapshot.entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    'utf8',
  );
}

async function currentAuditTasks(repoRoot, tasks) {
  const [verifierImplementationSource, composeImplementationSource] = await Promise.all([
    readFile(join(repoRoot, 'packages/headless/harbor/maka_verifier.py')),
    readFile(
      join(
        repoRoot,
        'packages/headless/harbor',
        HARBOR_ORACLE_EXECUTION_POLICY.environment.composeFile,
      ),
    ),
  ]);
  const executionPolicyFingerprint = buildHarnessOracleExecutionPolicyFingerprint({
    verifierImplementationSource,
    composeImplementationSource,
  });
  const digestCache = new Map();
  return buildHarnessOracleAuditTasks({
    tasks,
    executionPolicyFingerprint,
    environment: 'docker',
    platform: DOCKER_PLATFORM,
    resolveBaseImageDigest: (reference, platform) =>
      resolveHarnessOracleBaseImageDigest(reference, platform, digestCache),
  });
}

async function readSnapshot(path) {
  return parseHarnessOracleRegistrySnapshot(JSON.parse(await readFile(path, 'utf8')));
}

async function readPlan(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (
    !value ||
    typeof value !== 'object' ||
    value.schemaVersion !== AUDIT_PLAN_SCHEMA_VERSION ||
    !Array.isArray(value.tasks) ||
    !Array.isArray(value.reusedEntries) ||
    typeof value.fingerprint !== 'string'
  )
    throw new Error('Oracle audit plan is malformed');
  const { fingerprint, ...body } = value;
  if (fingerprint !== fingerprintHarnessOracleDocument(body)) {
    throw new Error('Oracle audit plan fingerprint is invalid');
  }
  return value;
}

async function readJsonFilesRecursively(root) {
  const values = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        values.push(JSON.parse(await readFile(path, 'utf8')));
      }
    }
  }
  await walk(root);
  return values;
}

function workflowProvenance(env = process.env) {
  return {
    issuer: 'github-actions',
    repository: requiredEnv(env, 'GITHUB_REPOSITORY'),
    workflow: requiredEnv(env, 'GITHUB_WORKFLOW'),
    commitSha: requiredEnv(env, 'GITHUB_SHA'),
    runId: requiredEnv(env, 'GITHUB_RUN_ID'),
    runAttempt: requiredEnv(env, 'GITHUB_RUN_ATTEMPT'),
  };
}

export async function workflowExecutionProvenance({
  env = process.env,
  readToolVersion = async (command, args) => (await execFileAsync(command, args)).stdout.trim(),
} = {}) {
  const [harborVersion, dockerVersion, dockerBuildxVersion] = await Promise.all([
    readToolVersion('harbor', ['--version']),
    readToolVersion('docker', ['--version']),
    readToolVersion('docker', ['buildx', 'version']),
  ]);
  const expectedHarborVersion = HARBOR_ORACLE_EXECUTION_POLICY.harborVersion;
  const escapedHarborVersion = expectedHarborVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`(^|[^0-9.])${escapedHarborVersion}([^0-9.]|$)`).test(harborVersion)) {
    throw new Error(
      `Harbor runtime does not match controlled Oracle policy ${expectedHarborVersion}: ${harborVersion}`,
    );
  }
  return {
    ...workflowProvenance(env),
    runtime: {
      nodeVersion: process.version,
      harborVersion,
      dockerVersion,
      dockerBuildxVersion,
    },
  };
}

function repoRootFromArgs(args) {
  return args['repo-root']
    ? resolve(args['repo-root'])
    : resolve(fileURLToPath(new URL('../../..', import.meta.url)));
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || value === undefined)
      throw new Error(`invalid argument ${name ?? ''}`);
    parsed[name.slice(2)] = value;
  }
  return parsed;
}

function requiredArg(args, name) {
  const value = args[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function requiredEnv(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function withFingerprint(body) {
  return { ...body, fingerprint: fingerprintHarnessOracleDocument(body) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
