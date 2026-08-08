import { createServer } from 'node:http';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { e2eHomeDir, expect, test } from './fixtures';

test('imports a Codex rollout through the Desktop Runtime Host', async ({
  externalSessionImportWindow: page,
}) => {
  const modelCatalog = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        object: 'list',
        data: [
          {
            id: 'external-import-model',
            object: 'model',
            created: 0,
            owned_by: 'e2e',
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => modelCatalog.listen(0, '127.0.0.1', resolve));
  const address = modelCatalog.address();
  if (address === null || typeof address === 'string') throw new Error('Model catalog did not bind');

  try {
    await page.evaluate(async (baseUrl) => {
      await window.maka.connections.create({
        slug: 'external-import-e2e',
        name: 'External import E2E',
        providerType: 'openai-compatible',
        baseUrl,
        defaultModel: 'external-import-model',
        apiKey: 'e2e-placeholder',
      });
      await window.maka.connections.fetchModels('external-import-e2e');
      await window.maka.connections.update('external-import-e2e', {
        defaultModel: 'external-import-model',
        enabledModelIds: ['external-import-model'],
      });
      await window.maka.connections.setDefault('external-import-e2e');
    }, `http://127.0.0.1:${address.port}/v1`);

    await importCodexRollout(page);
  } finally {
    await new Promise<void>((resolve, reject) => {
      modelCatalog.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

async function importCodexRollout(page: Page): Promise<void> {
  const rolloutDirectory = path.join(e2eHomeDir(), '.codex', 'sessions', '2026', '08', '08');
  await mkdir(rolloutDirectory, { recursive: true });
  await copyFile(
    path.resolve('../../packages/storage/src/__tests__/fixtures/codex-rollout-v0.144.jsonl'),
    path.join(rolloutDirectory, 'rollout-2026-08-08T00-00-00-codex-session-1.jsonl'),
  );

  const expandSidebar = page.getByRole('button', { name: '展开侧边栏' });
  if (await expandSidebar.isVisible()) await expandSidebar.click();
  await page.getByRole('button', { name: '导入会话', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: '导入外部会话' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Codex', exact: true })).toBeVisible();

  const sourceSession = dialog.getByRole('button').filter({ hasText: 'Fix the parser' });
  await expect(sourceSession).toHaveCount(1);
  await sourceSession.click();
  await dialog.getByRole('button', { name: '导入会话', exact: true }).click();

  await expect(dialog).toBeHidden();
  await expect(
    page.locator('.maka-user-message').getByText('Fix the parser', { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.maka-assistant-answer').getByText('I found the issue.', { exact: true }),
  ).toBeVisible();
}
