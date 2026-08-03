#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearDevelopmentSession,
  createDevelopmentSession,
  quitMacosDevelopmentApp,
  recoverStaleDevelopmentSession,
  resolveMacosDevelopmentLaunch,
  waitForMacosDevelopmentApp,
  writeDevelopmentSession,
} from './dev-app-runtime.mjs';

const desktopDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repoRoot = resolve(desktopDir, '..', '..');
const cliArgs = process.argv.slice(2);
const forwardedArgs = [desktopDir, ...cliArgs];
const macosLaunch = await resolveMacosDevelopmentLaunch();
if (macosLaunch) {
  await recoverStaleDevelopmentSession();
  const userDataArg = cliArgs.find((arg) => arg.startsWith('--user-data-dir='));
  writeDevelopmentSession(createDevelopmentSession({
    supervisorPid: process.pid,
    env: process.env,
    userDataDir: userDataArg?.slice('--user-data-dir='.length),
    electronArgs: cliArgs.filter((arg) => !arg.startsWith('--user-data-dir=')),
  }));
}
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
const keepAlive = macosLaunch ? setInterval(() => undefined, 60_000) : null;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (macosLaunch) {
    await quitMacosDevelopmentApp();
    clearDevelopmentSession();
  } else child.kill('SIGTERM');
  if (keepAlive) clearInterval(keepAlive);
  process.exitCode = 0;
}
child.on('error', (error) => {
  console.error(`[dev-app] failed to start: ${error.message}`);
  void stop().then(() => {
    process.exitCode = 1;
  });
});
child.on('exit', (code, signal) => {
  if (!macosLaunch && !stopping) {
    process.exitCode = signal ? 1 : (code ?? 0);
  } else if (macosLaunch && code && code !== 0) {
    void stop().then(() => {
      process.exitCode = code;
    });
  }
});
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
if (macosLaunch) {
  void waitForMacosDevelopmentApp().then(
    () => console.log('[dev-app] Maka Dev startup handshake complete'),
    (error) => {
      console.error(`[dev-app] ${error.message}`);
      void stop().then(() => {
        process.exitCode = 1;
      });
    },
  );
}
// `open` exits immediately after handing the launch to LaunchServices. The
// timer above keeps the supervisor alive so app restarts can recover its session.
