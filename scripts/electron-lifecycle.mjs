// Bounded teardown for a spawned Electron tree.
//
// `ElectronApplication.close()` waits for the app to quit and has no deadline:
// a wedged main process turns teardown into an infinite hang, and everything
// sequenced after it — temp-dir cleanup, the next fixture, a CI job — never
// runs. Every consumer that launches an Electron app (the Playwright E2E
// suite and the migration contract harness) closes through here instead, so
// a launch that goes wrong costs seconds, not a hung run.
//
// Lives in scripts/ beside fixture-env.mjs for the same reason: a bare-node
// .mjs harness cannot import a .ts module, while the Playwright suite can
// import this one. One launch concern, one home.
import { terminateChildProcessTree } from '@maka/runtime';

/**
 * @typedef {{
 *   exitCode: number | null,
 *   signalCode: NodeJS.Signals | null,
 *   kill(signal: NodeJS.Signals): boolean,
 *   once(event: 'exit', listener: () => void): unknown,
 *   off(event: 'exit', listener: () => void): unknown,
 * }} ElectronProcessHandle
 */

/**
 * @typedef {{
 *   close(): Promise<void>,
 *   process(): ElectronProcessHandle,
 * }} ClosableElectronApplication
 */

/**
 * @typedef {(child: ElectronProcessHandle, signal: 'SIGKILL') => Promise<boolean>} ProcessTreeTerminator
 */

/** @type {ProcessTreeTerminator} */
const terminateElectronProcessTree = (child, signal) =>
  terminateChildProcessTree(
    /** @type {import('node:child_process').ChildProcess} */ (child),
    signal,
  );

/**
 * Close gracefully within `graceMs`, then SIGKILL the process tree and wait
 * up to 2s for the exit to land. Throws if the process survives the kill.
 *
 * @param {ClosableElectronApplication} app
 * @param {number} graceMs
 * @param {ProcessTreeTerminator} [terminateTree]
 * @returns {Promise<void>}
 */
export async function closeElectronApplication(
  app,
  graceMs,
  terminateTree = terminateElectronProcessTree,
) {
  const child = app.process();
  const gracefulClose = app.close().then(
    () => true,
    () => false,
  );
  if (await settlesWithin(gracefulClose, graceMs)) return;

  if (child.exitCode === null && child.signalCode === null) {
    await terminateTree(child, 'SIGKILL');
  }
  if (!(await waitForExit(child, 2_000))) {
    throw new Error('Electron process did not exit after SIGKILL');
  }
}

/**
 * @param {Promise<boolean>} promise
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function settlesWithin(promise, timeoutMs) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * @param {ElectronProcessHandle} child
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {(() => void) | undefined} */
  let onExit;
  try {
    return await Promise.race([
      new Promise((resolve) => {
        onExit = () => resolve(true);
        child.once('exit', onExit);
      }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onExit) child.off('exit', onExit);
  }
}
