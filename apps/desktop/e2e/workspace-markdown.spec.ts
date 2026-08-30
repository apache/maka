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

import { expect, test } from './fixtures';

test('opens explicit, bare, and sent workspace Markdown references in the side preview', async ({
  workspaceMarkdownWindow: page,
}) => {
  const transcript = page.locator('[data-chat-scroll-container="true"]');
  await expect(transcript).toBeVisible();
  await expect(page.locator('[data-workspace-file="tools/setup.command"]')).toHaveCount(0);

  const explicitLink = transcript.locator(
    '[data-workspace-file="docs/guide with spaces.md"]',
  );
  await explicitLink.click();
  const explicitPreview = page.locator(
    '.maka-workspace-file-preview[data-workspace-file="docs/guide with spaces.md"]',
  );
  await expect(explicitPreview).toBeVisible();
  await expect(explicitPreview.getByText('Workspace guide')).toBeVisible();
  await expect(transcript.locator('[data-turn-id="turn-workspace-markdown"]')).toBeAttached();

  await explicitPreview.getByRole('button', { name: 'Back' }).click();
  const bareLink = transcript.locator('[data-workspace-file="docs/notes.md"]');
  await bareLink.click();
  const barePreview = page.locator(
    '.maka-workspace-file-preview[data-workspace-file="docs/notes.md"]',
  );
  await expect(barePreview.getByText('Workspace notes')).toBeVisible();

  await barePreview.getByRole('button', { name: 'Back' }).click();
  const sentFileReference = transcript.locator('[data-workspace-file="docs/chip.md"]');
  await sentFileReference.click();
  const sentFilePreview = page.locator(
    '.maka-workspace-file-preview[data-workspace-file="docs/chip.md"]',
  );
  await expect(sentFilePreview.getByText('Workspace chip')).toBeVisible();
});
