#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import electron from 'electron';
import { buildFixtureEnv } from './fixture-env.mjs';

const options = parseOptions(process.argv.slice(2));
const roots = [
  { name: 'baseline', root: options.baseline },
  { name: 'candidate', root: options.candidate },
];
const measurements = new Map(roots.map(({ name }) => [name, []]));

for (let iteration = 0; iteration < options.iterations; iteration += 1) {
  for (const subject of iteration % 2 === 0 ? roots : [...roots].reverse()) {
    measurements.get(subject.name).push(await measure(subject.root, iteration));
  }
}

const result = Object.fromEntries(
  [...measurements].map(([name, values]) => [name, summarize(values)]),
);
const regression = ((result.candidate.p95Ms - result.baseline.p95Ms) / result.baseline.p95Ms) * 100;
console.log(
  JSON.stringify(
    {
      iterations: options.iterations,
      metric: 'Electron spawn to first did-finish-load diagnostic, clean isolated profile',
      ...result,
      p95RegressionPercent: round(regression),
      passesFivePercentGate: regression <= 5,
    },
    null,
    2,
  ),
);

function parseOptions(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    values.set(arguments_[index], arguments_[index + 1]);
  }
  const baseline = resolveRequired(values.get('--baseline'), '--baseline');
  const candidate = resolveRequired(values.get('--candidate'), '--candidate');
  const iterations = Number(values.get('--iterations') ?? 20);
  if (!Number.isSafeInteger(iterations) || iterations < 5 || iterations > 100) {
    throw new Error('--iterations must be an integer from 5 to 100');
  }
  return { baseline, candidate, iterations };
}

function resolveRequired(value, label) {
  if (typeof value !== 'string' || !value || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute repository path`);
  }
  return resolve(value);
}

async function measure(root, iteration) {
  const profile = await mkdtemp(join(tmpdir(), 'maka-extension-startup-'));
  const isolatedHome = join(profile, 'isolated-home');
  await mkdir(isolatedHome, { recursive: true });
  const environment = buildFixtureEnv(profile, isolatedHome);
  environment.MAKA_REAL_WINDOW_SMOKE = '1';
  const started = performance.now();
  const child = spawn(electron, ['.', `--user-data-dir=${profile}`], {
    cwd: join(root, 'apps', 'desktop'),
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let output = '';
  try {
    return await new Promise((resolveMeasurement, rejectMeasurement) => {
      const timeout = setTimeout(
        () => rejectMeasurement(new Error(`startup timed out at iteration ${iteration}`)),
        20_000,
      );
      const settle = (error, value) => {
        clearTimeout(timeout);
        if (error) rejectMeasurement(error);
        else resolveMeasurement(value);
      };
      child.once('error', (error) => settle(error));
      child.once('exit', (code, signal) =>
        settle(new Error(`Electron exited before load: code=${code} signal=${signal}`)),
      );
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        if (!output.includes('"stage":"after-load"')) return;
        settle(undefined, performance.now() - started);
      });
      child.stderr.on('data', (chunk) => {
        output += chunk.toString();
      });
    });
  } finally {
    await stop(child);
    await rm(profile, { recursive: true, force: true });
  }
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    child.kill('SIGKILL');
  } else if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  await new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) resolveExit();
    else child.once('exit', resolveExit);
  });
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    minMs: round(sorted[0]),
    maxMs: round(sorted.at(-1)),
  };
}

function percentile(sorted, fraction) {
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
