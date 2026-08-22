import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { test, expect } from '@playwright/test';

const execFileAsync = promisify(execFile);
const electronPath = createRequire(import.meta.url)('electron') as string;

test('agent graph collapse chevron follows the disclosure state', async () => {
  const { stdout } = await execFileAsync(electronPath, ['e2e/agent-graph-chevron-smoke.mjs'], {
    cwd: process.cwd(),
    timeout: 30_000,
  });
  expect(stdout).toContain('Agent graph chevron browser smoke passed');
});
