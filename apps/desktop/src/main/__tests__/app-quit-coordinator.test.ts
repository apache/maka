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
      cleanup: async () => {},
      focusOrCreateWindow: () => {},
      onCleanupError: () => {},
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

    await new Promise<void>((resolve) => setImmediate(resolve));

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
      cleanup: async () => {
        cleanupCount += 1;
        await cleanupPending;
      },
      focusOrCreateWindow: () => {
        focusOrCreateCount += 1;
      },
      onCleanupError: () => {},
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
    assert.equal(cleanupCount, 1);
    assert.equal(preventedCount, 2);
    assert.equal(resumeQuitCount, 0);

    releaseCleanup();
    await cleanupPending;
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

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
    const coordinator = createAppQuitCoordinator({
      cleanup: () => new Promise<void>(() => {}),
      focusOrCreateWindow: () => {
        focusOrCreateCount += 1;
      },
      onCleanupError: () => {},
      resumeQuit: () => {},
    });
    const windowCreationSignal = coordinator.getWindowCreationSignal();

    coordinator.handleBeforeQuit({ preventDefault: () => {} });
    coordinator.focusOrCreateWindow();

    assert.equal(focusOrCreateCount, 0);
    assert.equal(windowCreationSignal?.aborted, true);
    assert.equal(coordinator.getWindowCreationSignal(), undefined);
  });

  it('reports cleanup failure without leaking an unhandled rejection', async () => {
    const cleanupError = new Error('close failed');
    const reportedErrors: unknown[] = [];
    let focusOrCreateCount = 0;
    let resumeQuitCount = 0;
    const deps = {
      cleanup: async () => {
        throw cleanupError;
      },
      focusOrCreateWindow: () => {
        focusOrCreateCount += 1;
      },
      onCleanupError: (error: unknown) => {
        reportedErrors.push(error);
      },
      resumeQuit: () => {
        resumeQuitCount += 1;
      },
    };
    const coordinator = createAppQuitCoordinator(deps);

    coordinator.handleBeforeQuit({ preventDefault: () => {} });
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
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
    assert.equal(coordinator.getWindowCreationSignal(), undefined);
  });
});
