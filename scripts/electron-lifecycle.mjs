/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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
// Resolved from the built dist (the package's entry point). On a fresh clone
// nothing under packages/ is built yet, and the raw ERR_MODULE_NOT_FOUND from
// deep inside an import chain (test file → harness → launcher → here) does
// not say what to do about it.
const { terminateChildProcessTree } = await import('@maka/runtime/process-tree-terminator').catch(
  (cause) => {
    throw new Error(
      "electron-lifecycle needs @maka/runtime's built dist. Run `npm --workspace @maka/runtime run build` (or any desktop build) first.",
      { cause },
    );
  },
);

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
  let child;
  try {
    child = app.process();
  } catch {
    // Playwright invalidates the process channel after Electron exits. There
    // is no live process tree left to terminate, so teardown is already done.
    await settlesWithin(
      app.close().then(
        () => true,
        () => true,
      ),
      graceMs,
    );
    return;
  }
  const gracefulClose = app.close().then(
    () => true,
    () => false,
  );
  if (await settlesWithin(gracefulClose, graceMs)) return;

  if (child.exitCode === null && child.signalCode === null) {
    await terminateTree(child, 'SIGKILL');
  }
  // The tree terminator signals the child's process GROUP. A child that was
  // not spawned detached is not a group leader, so the group signal reports
  // "no such process" and the terminator concludes the tree is gone while
  // the root lives on — measured with the smoke gate's visible window, which
  // also ignores SIGTERM. A direct kill always lands on the root itself.
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Exited between the check and the signal.
    }
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
