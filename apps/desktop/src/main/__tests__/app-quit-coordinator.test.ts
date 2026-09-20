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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAppQuitCoordinator } from '../app-quit-coordinator.js';

describe('app quit coordinator', () => {
  it('keeps quit prevented until it resumes in a fresh event-loop turn', async () => {
    let resumeQuitCount = 0;
    let preventedCount = 0;
    const coordinator = createAppQuitCoordinator({
      prepareToQuit: async () => 'ready' as const,
      cleanup: async () => {},
      focusOrCreateWindow: () => {},
      forceExit: () => {},
      onPreparationError: () => {},
      onCleanupError: () => {},
      onWindowCreationError: () => {},
      resumeQuit: () => {
        resumeQuitCount += 1;
      },
    });

    const event = {
      preventDefault: () => {
        preventedCount += 1;
      },
    };
    coordinator.handleBeforeQuit(event);
    await Promise.resolve();
    await Promise.resolve();
    coordinator.handleBeforeQuit(event);

    assert.equal(resumeQuitCount, 0);
    assert.equal(preventedCount, 2);

    await flushQuitCoordinator();

    assert.equal(resumeQuitCount, 1);
  });

  it('runs async cleanup once and resumes quitting when it settles', async () => {
    let cleanupCount = 0;
    let focusOrCreateCount = 0;
    let resumeQuitCount = 0;
    let releaseCleanup: () => void = () => {};
    const cleanupPending = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const coordinator = createAppQuitCoordinator({
      prepareToQuit: async () => 'ready',
      cleanup: async () => {
        cleanupCount += 1;
        await cleanupPending;
      },
      focusOrCreateWindow: () => {
        focusOrCreateCount += 1;
      },
      forceExit: () => {},
      onPreparationError: () => {},
      onCleanupError: () => {},
      onWindowCreationError: () => {},
      resumeQuit: () => {
        resumeQuitCount += 1;
      },
    });
    let preventedCount = 0;
    const event = {
      preventDefault: () => {
        preventedCount += 1;
      },
    };

    coordinator.handleBeforeQuit(event);
    coordinator.handleBeforeQuit(event);
    await flushQuitCoordinator();
    assert.equal(cleanupCount, 1);
    assert.equal(preventedCount, 2);
    assert.equal(resumeQuitCount, 0);

    releaseCleanup();
    await cleanupPending;
    await Promise.resolve();
    await flushQuitCoordinator();

    assert.equal(resumeQuitCount, 1);

    coordinator.focusOrCreateWindow();
    coordinator.handleBeforeQuit(event);

    assert.equal(focusOrCreateCount, 0);
    assert.equal(preventedCount, 2);
    assert.equal(cleanupCount, 1);
    assert.equal(resumeQuitCount, 1);
  });

  it('does not reopen the main window after quit cleanup starts', () => {
    let focusOrCreateCount = 0;
    let windowCreationSignal: AbortSignal | undefined;
    const coordinator = createAppQuitCoordinator({
      prepareToQuit: async () => 'ready',
      cleanup: () => new Promise<void>(() => {}),
      focusOrCreateWindow: (signal) => {
        focusOrCreateCount += 1;
        windowCreationSignal = signal;
      },
      forceExit: () => {},
      onPreparationError: () => {},
      onCleanupError: () => {},
      onWindowCreationError: () => {},
      resumeQuit: () => {},
    });

    coordinator.focusOrCreateWindow();
    coordinator.handleBeforeQuit({ preventDefault: () => {} });
    coordinator.focusOrCreateWindow();

    assert.equal(focusOrCreateCount, 1);
    assert.equal(windowCreationSignal?.aborted, true);
  });

  it('restores the running app when quit preparation is cancelled', async () => {
    let cleanupCount = 0;
    let focusOrCreateCount = 0;
    let resumeQuitCount = 0;
    const coordinator = createAppQuitCoordinator({
      prepareToQuit: async () => 'cancelled',
      cleanup: async () => {
        cleanupCount += 1;
      },
      focusOrCreateWindow: () => {
        focusOrCreateCount += 1;
      },
      forceExit: () => {},
      onPreparationError: () => {},
      onCleanupError: () => {},
      onWindowCreationError: () => {},
      resumeQuit: () => {
        resumeQuitCount += 1;
      },
    });

    coordinator.handleBeforeQuit({ preventDefault: () => {} });
    await flushQuitCoordinator();

    assert.equal(cleanupCount, 0);
    assert.equal(resumeQuitCount, 0);
    assert.equal(focusOrCreateCount, 1);
  });

  it('reports window creation failure without leaking an unhandled rejection', async () => {
    const failure = new Error('window load failed');
    const reportedErrors: unknown[] = [];
    const coordinator = createAppQuitCoordinator({
      prepareToQuit: async () => 'ready',
      cleanup: async () => {},
      focusOrCreateWindow: async () => {
        throw failure;
      },
      forceExit: () => {},
      onPreparationError: () => {},
      onCleanupError: () => {},
      onWindowCreationError: (error) => reportedErrors.push(error),
      resumeQuit: () => {},
    });

    coordinator.focusOrCreateWindow();
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(reportedErrors, [failure]);
  });

  it('cancels quit without closing resources when Host retirement preparation fails', async () => {
    const preparationError = new Error('retirement failed');
    const reportedErrors: unknown[] = [];
    let preparationCount = 0;
    let cleanupCount = 0;
    let focusOrCreateCount = 0;
    let resumeQuitCount = 0;
    const coordinator = createAppQuitCoordinator({
      prepareToQuit: async () => {
        preparationCount += 1;
        if (preparationCount === 1) throw preparationError;
        return 'ready';
      },
      cleanup: async () => {
        cleanupCount += 1;
      },
      focusOrCreateWindow: () => {
        focusOrCreateCount += 1;
      },
      forceExit: () => {},
      onPreparationError: (error) => reportedErrors.push(error),
      onCleanupError: () => {},
      onWindowCreationError: () => {},
      resumeQuit: () => {
        resumeQuitCount += 1;
      },
    });

    coordinator.handleBeforeQuit({ preventDefault: () => {} });
    await flushQuitCoordinator();

    assert.deepEqual(reportedErrors, [preparationError]);
    assert.equal(cleanupCount, 0);
    assert.equal(resumeQuitCount, 0);
    assert.equal(focusOrCreateCount, 1);

    coordinator.handleBeforeQuit({ preventDefault: () => {} });
    await flushQuitCoordinator();

    assert.equal(preparationCount, 2);
    assert.equal(cleanupCount, 1);
    assert.equal(resumeQuitCount, 1);
  });

  it('reports cleanup failure without leaking an unhandled rejection', async () => {
    const cleanupError = new Error('close failed');
    const reportedErrors: unknown[] = [];
    let focusOrCreateCount = 0;
    let resumeQuitCount = 0;
    const deps = {
      prepareToQuit: async () => 'ready' as const,
      cleanup: async () => {
        throw cleanupError;
      },
      focusOrCreateWindow: () => {
        focusOrCreateCount += 1;
      },
      forceExit: () => {},
      onPreparationError: () => {},
      onCleanupError: (error: unknown) => {
        reportedErrors.push(error);
      },
      onWindowCreationError: () => {},
      resumeQuit: () => {
        resumeQuitCount += 1;
      },
    };
    const coordinator = createAppQuitCoordinator(deps);

    coordinator.handleBeforeQuit({ preventDefault: () => {} });
    await flushQuitCoordinator();
    let secondQuitPrevented = false;
    coordinator.focusOrCreateWindow();
    coordinator.handleBeforeQuit({
      preventDefault: () => {
        secondQuitPrevented = true;
      },
    });

    assert.deepEqual(reportedErrors, [cleanupError]);
    assert.equal(focusOrCreateCount, 0);
    assert.equal(resumeQuitCount, 1);
    assert.equal(secondQuitPrevented, false);
  });

  it('forces exit when cleanup never settles', async () => {
    const timeouts: Array<{ stage: string; timeoutMs: number }> = [];
    let forceExitCount = 0;
    let resumeQuitCount = 0;
    const coordinator = createAppQuitCoordinator({
      prepareToQuit: async () => 'ready',
      cleanup: () => new Promise<void>(() => {}),
      focusOrCreateWindow: () => {},
      forceExit: () => {
        forceExitCount += 1;
      },
      onPreparationError: () => {},
      onCleanupError: () => {},
      onWindowCreationError: () => {},
      onQuitTimeout: (stage, timeoutMs) => {
        timeouts.push({ stage, timeoutMs });
      },
      resumeQuit: () => {
        resumeQuitCount += 1;
      },
      cleanupTimeoutMs: 10,
    });

    coordinator.handleBeforeQuit({ preventDefault: () => {} });
    await delay(60);

    assert.deepEqual(timeouts, [{ stage: 'cleaning', timeoutMs: 10 }]);
    assert.equal(forceExitCount, 1);
    assert.equal(resumeQuitCount, 0);
  });

  it('still quits when quit preparation never settles', async () => {
    const timeouts: string[] = [];
    let cleanupCount = 0;
    let forceExitCount = 0;
    let resumeQuitCount = 0;
    const coordinator = createAppQuitCoordinator({
      prepareToQuit: () => new Promise<'ready' | 'cancelled'>(() => {}),
      cleanup: async () => {
        cleanupCount += 1;
      },
      focusOrCreateWindow: () => {},
      forceExit: () => {
        forceExitCount += 1;
      },
      onPreparationError: () => {},
      onCleanupError: () => {},
      onWindowCreationError: () => {},
      onQuitTimeout: (stage) => {
        timeouts.push(stage);
      },
      resumeQuit: () => {
        resumeQuitCount += 1;
      },
      prepareTimeoutMs: 10,
    });

    coordinator.handleBeforeQuit({ preventDefault: () => {} });
    await delay(60);
    await flushQuitCoordinator();

    assert.deepEqual(timeouts, ['preparing']);
    assert.equal(cleanupCount, 1);
    assert.equal(forceExitCount, 0);
    assert.equal(resumeQuitCount, 1);
  });

  it('unwinds staged work when quit preparation is cancelled', async () => {
    let abandonedCount = 0;
    const coordinator = createAppQuitCoordinator({
      prepareToQuit: async () => 'cancelled',
      cleanup: async () => {},
      focusOrCreateWindow: () => {},
      forceExit: () => {},
      onPreparationError: () => {},
      onCleanupError: () => {},
      onWindowCreationError: () => {},
      onQuitAbandoned: () => {
        abandonedCount += 1;
      },
      resumeQuit: () => {},
    });

    coordinator.handleBeforeQuit({ preventDefault: () => {} });
    await flushQuitCoordinator();

    assert.equal(abandonedCount, 1);
  });

  it('unwinds staged work when quit preparation fails', async () => {
    let abandonedCount = 0;
    const coordinator = createAppQuitCoordinator({
      prepareToQuit: async () => {
        throw new Error('retirement failed');
      },
      cleanup: async () => {},
      focusOrCreateWindow: () => {},
      forceExit: () => {},
      onPreparationError: () => {},
      onCleanupError: () => {},
      onWindowCreationError: () => {},
      onQuitAbandoned: () => {
        abandonedCount += 1;
      },
      resumeQuit: () => {},
    });

    coordinator.handleBeforeQuit({ preventDefault: () => {} });
    await flushQuitCoordinator();

    assert.equal(abandonedCount, 1);
  });

  it('leaves staged work alone once the quit is committed', async () => {
    // Unwinding here would resume a Host the process is about to drop, and
    // an install handoff would be rolled back out from under the updater.
    let abandonedCount = 0;
    let resumeQuitCount = 0;
    const coordinator = createAppQuitCoordinator({
      prepareToQuit: async () => 'ready',
      cleanup: async () => {},
      focusOrCreateWindow: () => {},
      forceExit: () => {},
      onPreparationError: () => {},
      onCleanupError: () => {},
      onWindowCreationError: () => {},
      onQuitAbandoned: () => {
        abandonedCount += 1;
      },
      resumeQuit: () => {
        resumeQuitCount += 1;
      },
    });

    coordinator.handleBeforeQuit({ preventDefault: () => {} });
    await flushQuitCoordinator();

    assert.equal(resumeQuitCount, 1);
    assert.equal(abandonedCount, 0);
  });

  it('leaves staged work alone when a stuck quit is forced through', async () => {
    let abandonedCount = 0;
    let forceExitCount = 0;
    const coordinator = createAppQuitCoordinator({
      prepareToQuit: async () => 'ready',
      cleanup: () => new Promise<void>(() => {}),
      focusOrCreateWindow: () => {},
      forceExit: () => {
        forceExitCount += 1;
      },
      onPreparationError: () => {},
      onCleanupError: () => {},
      onWindowCreationError: () => {},
      onQuitAbandoned: () => {
        abandonedCount += 1;
      },
      resumeQuit: () => {},
      cleanupTimeoutMs: 10,
    });

    coordinator.handleBeforeQuit({ preventDefault: () => {} });
    await delay(60);

    assert.equal(forceExitCount, 1);
    assert.equal(abandonedCount, 0);
  });

  it('does not report an abandoned stage as a failure', async () => {
    // A stage that stopped answering is not a Host that refused: routing it to
    // the error sinks would invent a failure the product then has to explain.
    const preparationErrors: unknown[] = [];
    const cleanupErrors: unknown[] = [];
    let forceExitCount = 0;
    const coordinator = createAppQuitCoordinator({
      prepareToQuit: () => new Promise<'ready' | 'cancelled'>(() => {}),
      cleanup: () => new Promise<void>(() => {}),
      focusOrCreateWindow: () => {},
      forceExit: () => {
        forceExitCount += 1;
      },
      onPreparationError: (error) => {
        preparationErrors.push(error);
      },
      onCleanupError: (error) => {
        cleanupErrors.push(error);
      },
      onWindowCreationError: () => {},
      resumeQuit: () => {},
      prepareTimeoutMs: 5,
      cleanupTimeoutMs: 5,
    });

    coordinator.handleBeforeQuit({ preventDefault: () => {} });
    await delay(60);

    assert.deepEqual(preparationErrors, []);
    assert.deepEqual(cleanupErrors, []);
    assert.equal(forceExitCount, 1);
  });
});

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function flushQuitCoordinator(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
