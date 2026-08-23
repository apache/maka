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

import { test, expect, COMPOSER_INPUT } from './fixtures';

/**
 * Arming a Goal starts unattended token spending, and the two budgets in this
 * dialog are what stops it. A budget the form shows but does not send is
 * therefore the one failure this dialog must not have — most sharply when the
 * value is dropped rather than altered, because an absent token budget is not
 * a smaller ceiling but no ceiling at all.
 *
 * The assertions read the Goal back from the Host rather than watching the
 * bridge call, so they answer what was actually armed.
 */
test('an unsendable budget blocks Start instead of arming a different one', async ({
  window: page,
}) => {
  // The ＋ menu only offers a Goal for a Session that exists, so seed one and
  // let its Turn settle first — a live Turn disables the entry too.
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('seed session');
  await composer.press('Enter');
  await expect(page.getByRole('log').getByText(/Fake backend received: seed session/)).toBeVisible();
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(1, { timeout: 20_000 });

  const sessionId = await page.evaluate(async () => (await window.maka.sessions.list())[0]?.id);
  expect(sessionId).toBeTruthy();
  const armedGoal = () =>
    page.evaluate(async (id: string) => await window.maka.goal.get(id), sessionId as string);

  await page.getByRole('button', { name: '添加上下文' }).click();
  await page.getByRole('menuitem', { name: '设定 Goal…' }).click();

  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/达成条件/).fill('所有测试通过');
  const start = dialog.getByRole('button', { name: '开始' });
  await expect(start).toBeEnabled();

  // Below the Host's own minimum. The field this replaced kept such text to
  // itself and left the sent budget null, so Start stayed enabled and armed no
  // ceiling at all.
  await dialog.getByLabel(/Token 预算/).fill('500');
  await expect(start).toBeDisabled();
  await expect(dialog.getByText(/请填不小于 1000 的整数/)).toBeVisible();

  await dialog.getByLabel(/Token 预算/).fill('5000');
  await expect(start).toBeEnabled();

  // Above the Host's ceiling on turns; the same rule from the other side.
  await dialog.getByLabel(/最多轮数/).fill('250');
  await expect(start).toBeDisabled();
  await expect(await armedGoal()).toBeNull();

  await dialog.getByLabel(/最多轮数/).fill('25');
  await expect(start).toBeEnabled();
  await start.click();

  await expect
    .poll(async () => {
      const goal = await armedGoal();
      return goal && {
        condition: goal.condition,
        maxIterations: goal.maxIterations,
        tokenBudget: goal.tokenBudget,
      };
    })
    .toEqual({ condition: '所有测试通过', maxIterations: 25, tokenBudget: 5000 });
});
