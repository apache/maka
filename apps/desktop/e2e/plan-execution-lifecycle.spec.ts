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

import { COMPOSER_INPUT, awaitSendReady, ensureSidebarExpanded, expect, test } from './fixtures';

/**
 * Plan mode's deterministic proposal prompt. Mirrors
 * `DESKTOP_E2E_PLAN_PROPOSAL_PROMPT` in
 * `packages/runtime-host/src/test-only/desktop-e2e-execution.ts`. The literal is
 * restated rather than imported because that test-only module has no package
 * subpath (the release manifest drops the test-only entry outright), so a
 * divergence fails this spec at its first assertion instead of passing quietly.
 */
const PLAN_PROPOSAL_PROMPT = '__e2e_plan_proposal__';

/**
 * Electron-owned mechanism: a Plan execution's progress is written to the Host's
 * Plan store *by the backend Turn* (the runtime binds `update_plan` per active
 * execution) and is read back by a *fresh renderer* through preload/IPC after the
 * whole Electron application is restarted — a new main process, a new Host
 * composition, a new renderer, and a re-opened SQLite Plan store. Every
 * assertion after `restart()` is about that cross-process durable read.
 *
 * What a lower-tier test would miss: `src/main/__tests__/plan-mode-panel-*.test.ts`
 * drive the panel against a faked `window.maka` and a fake DOM, so they cannot
 * show that an interrupted execution survives an application restart, that the
 * restarted renderer's `getPlanState` preload read returns the same step
 * statuses, or that Stop during a live Turn settles through
 * RootTurnCoordinator → SessionManager into a durable interruption. Those three
 * hops only exist once a real main process, a real Host and a real preload
 * bridge are all running.
 */
test('an approved Plan keeps its progress across Stop and a full Electron restart, then resumes to completion', async ({
  sessionLocalWindow,
}, testInfo) => {
  let { page } = sessionLocalWindow;
  const { restart } = sessionLocalWindow;

  // 1. Plan mode + proposal. The mode is entered through the composer's own ＋
  //    menu, so the Session the proposal lands in is created by the real path.
  await page.locator('.maka-composer .maka-composer-plus-menu button').click();
  await page.getByRole('menuitemcheckbox', { name: 'Plan', exact: true }).click();
  await expect(page.locator('.maka-composer-mode-button[data-mode="plan"]')).toBeVisible();

  await page.locator(COMPOSER_INPUT).fill(PLAN_PROPOSAL_PROMPT);
  await awaitSendReady(page);
  await page.locator(COMPOSER_INPUT).press('Enter');

  const proposalCard = page.locator('.plan-proposal-card[data-status="pending_approval"]');
  await expect(proposalCard).toBeVisible();
  await expect(proposalCard.locator('.plan-proposal-steps > li')).toHaveCount(3);

  await ensureSidebarExpanded(page);
  const sessionId = await page
    .locator('[data-session-id]:has([aria-current="page"])')
    .getAttribute('data-session-id');
  expect(sessionId).toBeTruthy();

  // 2. Approve through the panel's real control. Approval starts a second Host
  //    Turn whose request the E2E backend answers with one real `update_plan`
  //    write, so the panel has to show acquired progress — not the 0/3 an
  //    approval that never reached a Turn would leave behind.
  const executionPanel = page.locator('.plan-execution-panel');
  await page.getByRole('button', { name: '执行计划', exact: true }).click();
  await expect(executionPanel).toBeVisible();
  await expect(executionPanel.locator('.plan-execution-count')).toHaveText('1/3 步');
  await expect(executionPanel).toContainText('正在执行计划');

  // 3. Interrupt the live Turn through the composer's own stop control. The
  //    backend Turn is parked, so Stop is the user's only way out of it.
  const stop = page.getByRole('button', { name: '停止', exact: true });
  await expect(stop).toBeVisible();
  await stop.click();

  // Interruption preserves the progress the Turn had already recorded; losing
  // it would drop the panel back to 0/3 and make the resumed run redo step 1.
  await expect(executionPanel).toContainText('计划已中断');
  await expect(executionPanel.locator('.plan-execution-count')).toHaveText('1/3 步');

  // 4. The Electron-owned assertion: restart the application and let a fresh
  //    renderer read the interrupted execution back over preload/IPC.
  page = await restart();
  await ensureSidebarExpanded(page);
  await page.locator(`[data-session-id=${JSON.stringify(sessionId)}]`).click();

  const recoveredPanel = page.locator('.plan-execution-panel');
  await expect(recoveredPanel).toBeVisible();
  await expect(recoveredPanel).toContainText('计划已中断');
  await expect(recoveredPanel.locator('.plan-execution-count')).toHaveText('1/3 步');
  // Expand the execution body: the count alone would also match a run whose
  // per-step statuses were rebuilt, and those statuses are what resume reads.
  // The resume control lives in this body, so opening it is also how the user
  // reaches the action the next step takes. The disclosure's own trigger is the
  // root's direct-child button: the body's resume/abandon buttons are nested
  // inside the same root and stay out of the accessibility tree until it opens.
  await recoveredPanel.locator('.plan-execution-toggle > button').click();
  const recoveredSteps = recoveredPanel.locator('.plan-execution-steps > li');
  await expect(recoveredSteps).toHaveCount(3);
  await expect(recoveredSteps.nth(0)).toHaveAttribute('data-status', 'completed');
  await expect(recoveredSteps.nth(1)).toHaveAttribute('data-status', 'in_progress');
  await expect(recoveredSteps.nth(2)).toHaveAttribute('data-status', 'pending');
  await page.screenshot({ path: testInfo.outputPath('interrupted-after-restart.png') });

  // 5. Resume through the panel's real control, and let the resumed Turn finish
  //    every remaining step.
  await page.getByRole('button', { name: '恢复执行', exact: true }).click();

  // `PlanExecutionPanel` renders `active ?? lastInterrupted`, so once the last
  // step lands there is neither an active nor an interrupted execution and the
  // panel — its `3/3 步` label included — unmounts. Assert the terminal count on
  // the same authority the panel reads through (`getPlanState` over the preload
  // bridge) rather than inventing a DOM state the product never renders.
  await expect(page.locator('.plan-execution-panel')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const state = await window.maka.sessions.getPlanState(id);
        const execution = state.executions.at(-1);
        return {
          activeExecutionId: state.activeExecutionId ?? null,
          status: execution?.status ?? null,
          completed: execution?.steps.filter((step) => step.status === 'completed').length ?? 0,
          total: execution?.steps.length ?? 0,
        };
      }, sessionId!),
    )
    .toEqual({ activeExecutionId: null, status: 'completed', completed: 3, total: 3 });
});
