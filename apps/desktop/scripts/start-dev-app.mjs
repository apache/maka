#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDevelopmentEnvironmentFile,
  quitMacosDevelopmentApp,
  resolveMacosDevelopmentLaunch,
  writeDevelopmentEnvironment,
} from './dev-app-runtime.mjs';

const desktopDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repoRoot = resolve(desktopDir, '..', '..');
const cliArgs = process.argv.slice(2);
const macosLaunch = await resolveMacosDevelopmentLaunch();
if (macosLaunch) {
  writeDevelopmentEnvironment(
    createDevelopmentEnvironmentFile({ argv: cliArgs, env: process.env }),
  );
}
const electronBin =
  process.platform === 'win32'
    ? join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
    : join(repoRoot, 'node_modules', '.bin', 'electron');

const child = spawn(macosLaunch?.command ?? electronBin, macosLaunch?.args ?? ['.', ...cliArgs], {
  cwd: desktopDir,
  stdio: 'inherit',
  env: process.env,
});
// `open` returns at the LaunchServices handoff, so this process would exit
// immediately and leave nothing to stop the app on Ctrl-C.
const keepAlive = macosLaunch ? setInterval(() => undefined, 60_000) : null;
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (macosLaunch) await quitMacosDevelopmentApp();
  else child.kill('SIGTERM');
  if (keepAlive) clearInterval(keepAlive);
  process.exitCode = code;
}
child.on('error', (error) => {
  console.error(`[dev-app] failed to start: ${error.message}`);
  void stop(1);
});
child.on('exit', (code, signal) => {
  if (!macosLaunch && !stopping) process.exitCode = signal ? 1 : (code ?? 0);
  else if (macosLaunch && code) void stop(code);
});
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
