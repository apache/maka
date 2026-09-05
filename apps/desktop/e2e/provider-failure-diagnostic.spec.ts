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

import { expect, test } from './fixtures.js';

test('provider failure detail is collapsed until the user expands it', async ({
  providerFailureWindow: page,
}) => {
  const diagnostic = page.locator('.maka-turn-failed-diagnostic');
  await expect(diagnostic).not.toHaveAttribute('open', '');
  await expect(diagnostic.getByText('Provider 响应详情', { exact: true })).toBeVisible();
  await expect(diagnostic.locator('pre')).not.toBeVisible();

  await diagnostic.locator('summary').click();

  await expect(diagnostic).toHaveAttribute('open', '');
  await expect(diagnostic.locator('pre')).toHaveText(
    'Provider returned 429: request rate limit reached. Please retry after 30 seconds.',
  );
});
