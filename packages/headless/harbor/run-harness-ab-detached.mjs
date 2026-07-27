#!/usr/bin/env node

import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { resolveFixedPromptRunRoot } from '#fixed-prompt-task-source';
import { envPath as parseEnvPath } from '#headless-run-env';
import { resolveHarnessAbRunId, resolveHarnessComposition } from './run-harness-ab.mjs';

const JOURNAL_FILENAME = 'background-run.json';
const LOG_FILENAME = 'background-run.log';

const envPath = (name) => parseEnvPath(name, process.env[name]);

function detachedRunPaths() {
  const outDir = envPath('MAKA_HARNESS_AB_OUT_DIR');
  const composition = resolveHarnessComposition();
  const runId = resolveHarnessAbRunId(
    composition,
    process.env.MAKA_HARNESS_AB_RUN_ID,
    process.env.MAKA_HARNESS_AB_TASK_ID,
    process.env.MAKA_HARNESS_AB_TASK_IDS,
  );
  const runRoot = resolveFixedPromptRunRoot(outDir, runId, 'MAKA_HARNESS_AB_RUN_ID');
  return {
    runId,
    runRoot,
    logPath: join(runRoot, LOG_FILENAME),
  };
}

async function launchDetached() {
  const { runId, runRoot, logPath } = detachedRunPaths();
  await mkdir(runRoot, { recursive: true });
  const logFd = openSync(logPath, 'a', 0o600);
  const startedAt = new Date().toISOString();
  const workerPath = fileURLToPath(new URL('./run-harness-ab.mjs', import.meta.url));
  let child;
  try {
    child = spawn(process.execPath, [workerPath], {
      detached: true,
      env: {
        ...process.env,
        MAKA_HARNESS_AB_RUN_ID: runId,
        MAKA_HARNESS_AB_BACKGROUND_RUN: '1',
        MAKA_HARNESS_AB_DETACHED_STARTED_AT: startedAt,
      },
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  const journalPath = join(runRoot, JOURNAL_FILENAME);
  await waitForWorkerOwnership(child, journalPath, startedAt);
  child.unref();
  console.log(`detached harness runner started: pid ${child.pid}; journal ${journalPath}`);
}

function waitForWorkerOwnership(child, journalPath, startedAt) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const journalMatches = async () => {
      try {
        const journal = JSON.parse(await readFile(journalPath, 'utf8'));
        return journal.pid === child.pid && journal.startedAt === startedAt;
      } catch {
        return false;
      }
    };
    const poll = async () => {
      if (settled) return;
      if (await journalMatches()) {
        finish();
        return;
      }
      timer = setTimeout(poll, 10);
    };
    const onError = (error) => finish(error);
    const onExit = async (code, signal) => {
      if (await journalMatches()) {
        finish();
        return;
      }
      finish(
        new Error(
          `detached harness runner exited before acquiring the run lock (code ${code ?? 'null'}, signal ${signal ?? 'none'})`,
        ),
      );
    };
    child.once('error', onError);
    child.once('exit', onExit);
    void poll();
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  launchDetached().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
