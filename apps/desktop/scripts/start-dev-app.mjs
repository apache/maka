#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  quitMacosDevelopmentApp,
  resolveMacosDevelopmentLaunch,
} from './dev-app-runtime.mjs';

const desktopDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repoRoot = resolve(desktopDir, '..', '..');
const forwardedArgs = [desktopDir, ...process.argv.slice(2)];
const macosLaunch = resolveMacosDevelopmentLaunch(forwardedArgs);
const electronBin =
  process.platform === 'win32'
    ? join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
    : join(repoRoot, 'node_modules', '.bin', 'electron');
const command = macosLaunch?.command ?? electronBin;
const args = macosLaunch?.args ?? ['.', ...process.argv.slice(2)];

const child = spawn(command, args, {
  cwd: desktopDir,
  stdio: 'inherit',
  env: process.env,
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  if (macosLaunch) quitMacosDevelopmentApp();
  else child.kill('SIGTERM');
}
child.on('error', (error) => {
  console.error(`[dev-app] failed to start: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (!stopping) process.exitCode = signal ? 1 : (code ?? 0);
});
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
