#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { resolve } from 'node:path';

const manifestPath = argument('--manifest');
const manifest = JSON.parse(await readFile(resolve(manifestPath), 'utf8'));
const observations = [];

await observe('read_allowed', manifest.allowedRead, 'allowed', (path) => readFile(path));
await observe('read_denied', manifest.deniedRead, 'denied', (path) => readFile(path));
await observe('write_allowed', manifest.allowedWrite, 'allowed', (path) => writeFile(path, 'probe'));
await observe('write_denied', manifest.deniedWrite, 'denied', (path) => writeFile(path, 'probe'));
await observeNetwork(manifest.network);
observeEnvironment(manifest.forbiddenEnvironment ?? []);
await observeDescendant();

const passed = observations.every((item) => item.expected === item.actual);
process.stdout.write(`${JSON.stringify({ version: 1, passed, observations }, null, 2)}\n`);
if (!passed) process.exitCode = 1;

async function observe(operation, path, expected, action) {
  if (!path) return;
  try {
    await action(path);
    observations.push({ operation, expected, actual: 'allowed' });
  } catch (error) {
    observations.push({ operation, expected, actual: 'denied', code: error.code ?? 'unknown' });
  }
}

async function observeNetwork(network) {
  if (!network) return;
  const actual = await new Promise((done) => {
    const socket = connect({ host: network.host, port: network.port });
    const finish = (result) => {
      socket.destroy();
      done(result);
    };
    socket.setTimeout(network.timeoutMs ?? 1500, () => finish('denied'));
    socket.once('connect', () => finish('allowed'));
    socket.once('error', () => finish('denied'));
  });
  observations.push({ operation: 'network_connect', expected: network.expected, actual });
}

function observeEnvironment(names) {
  for (const name of names) {
    observations.push({
      operation: `environment:${name}`,
      expected: 'absent',
      actual: Object.hasOwn(process.env, name) ? 'present' : 'absent',
    });
  }
}

async function observeDescendant() {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("child-ok")'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  const code = await new Promise((done) => child.once('exit', done));
  observations.push({
    operation: 'descendant_launch',
    expected: 'managed',
    actual: code === 0 && stdout === 'child-ok' ? 'managed' : 'failed',
    pid: child.pid,
  });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return process.argv[index + 1];
}
