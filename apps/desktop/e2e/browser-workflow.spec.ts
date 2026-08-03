import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { expect, test } from './fixtures';

async function startWorkflowServer(): Promise<{
  origin: string;
  makeReplayMissWaitCondition(): void;
  close(): Promise<void>;
}> {
  let replayMissesWaitCondition = false;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (pathname === '/start') {
      setTimeout(() => {
        response.end(`<!doctype html>
          <html><body>
            <a data-testid="open-form" href="/form">Open form</a>
          </body></html>`);
      }, 150);
      return;
    }
    if (pathname === '/native-form') {
      response.end(`<!doctype html>
        <html><body>
          <form method="post" action="/native-submit">
            <input data-testid="native-name" name="name">
            <button data-testid="native-submit" type="submit">Submit</button>
          </form>
        </body></html>`);
      return;
    }
    if (pathname === '/native-submit') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        response.end(`<!doctype html><html><body>${request.method}:${Buffer.concat(chunks).toString('utf8')}</body></html>`);
      });
      return;
    }
    if (pathname === '/form') {
      response.end(`<!doctype html>
        <html><body>
          <form id="profile-form">
            <label>Name <input data-testid="username" name="username"></label>
            <input data-testid="username" aria-hidden="true" tabindex="-1">
            <label>Password <input data-testid="password" name="password" type="password"></label>
            <label><input data-testid="billing-monthly" name="billing" type="radio" value="monthly" checked> Monthly</label>
            <label><input data-testid="billing-yearly" name="billing" type="radio" value="yearly"> Yearly</label>
            <button data-testid="submit" type="submit">Submit</button>
          </form>
          <output id="result"></output>
          <script>
            document.querySelector('#profile-form').addEventListener('submit', (event) => {
              event.preventDefault();
              const name = document.querySelector('[data-testid="username"]').value;
              const password = document.querySelector('[data-testid="password"]').value;
              const billing = document.querySelector('input[name="billing"]:checked').value;
              document.querySelector('#result').textContent = 'done:' + name + ':' + password + ':' + billing;
              history.pushState({}, '', '/form/complete');
              ${replayMissesWaitCondition ? '' : `setTimeout(() => {
                const marker = document.createElement('span');
                marker.dataset.testid = 'complete';
                marker.textContent = 'Complete';
                document.body.append(marker);
              }, 50);`}
            });
          </script>
        </body></html>`);
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback workflow server did not bind.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    makeReplayMissWaitCondition: () => {
      replayMissesWaitCondition = true;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function evaluateBrowser<T>(
  app: ElectronApplication,
  url: string,
  script: string,
): Promise<T | null> {
  return app.evaluate(
    async ({ webContents }, input) => {
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === input.url);
      if (!contents) return null;
      try {
        return await contents.executeJavaScript(input.script, true);
      } catch {
        return null;
      }
    },
    { url, script },
  ) as Promise<T>;
}

test('records, persists, and deterministically replays a loopback workflow', async ({
  browserWorkflowWindow: { page, app, userDataDir },
}) => {
  const server = await startWorkflowServer();
  try {
    const startUrl = `${server.origin}/start`;
    const formUrl = `${server.origin}/form`;
    const completeUrl = `${server.origin}/form/complete`;
    const nativeFormUrl = `${server.origin}/native-form`;
    const nativeSubmitUrl = `${server.origin}/native-submit`;
    const workbar = page.locator('.maka-session-workbar-panel[data-placement="right"]');
    await page.getByRole('button', { name: '打开工作栏标签' }).click();
    const picker = page.getByRole('list', { name: '打开工具' });
    await expect(picker).toBeVisible();
    await picker.getByRole('button', { name: /浏览器/ }).click();

    const address = workbar.getByRole('textbox', { name: '浏览器地址' });
    await address.fill(nativeFormUrl);
    await address.press('Enter');
    await expect.poll(() => address.inputValue()).toBe(nativeFormUrl);
    await evaluateBrowser(
      app,
      nativeFormUrl,
      `(() => {
        document.querySelector('[data-testid="native-name"]').value = 'Alice';
        document.querySelector('form').requestSubmit();
      })()`,
    );
    await expect.poll(() => address.inputValue()).toBe(nativeSubmitUrl);
    await expect
      .poll(() => evaluateBrowser<string>(app, nativeSubmitUrl, 'document.body.textContent'))
      .toBe('POST:name=Alice');

    await address.fill(startUrl);
    await address.press('Enter');
    await expect.poll(() => address.inputValue()).toBe(startUrl);

    await workbar.getByRole('button', { name: '开始录制操作流程' }).click();
    await expect(workbar.getByRole('button', { name: '停止录制操作流程' })).toBeVisible();
    await evaluateBrowser(
      app,
      startUrl,
      `console.debug('__MAKA_BROWSER_WORKFLOW_EVENT_V1__:' + JSON.stringify({
        kind: 'type',
        locator: { kind: 'name', value: 'password' },
        value: 'page-forged-secret',
        sensitive: false,
        timestamp: Date.now(),
      }))`,
    );

    await evaluateBrowser(app, startUrl, `document.querySelector('[data-testid="open-form"]').click()`);
    await expect.poll(() => address.inputValue()).toBe(formUrl);
    await expect
      .poll(() => evaluateBrowser<boolean>(app, formUrl, `Boolean(window.__makaBrowserWorkflowRecorderV1)`))
      .toBe(false);

    await evaluateBrowser(
      app,
      formUrl,
      `(() => {
        const yearly = document.querySelector('[data-testid="billing-yearly"]');
        yearly.checked = true;
        yearly.dispatchEvent(new Event('input', { bubbles: true }));
        const type = (testId, value) => {
          const input = document.querySelector('[data-testid="' + testId + '"]');
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        };
        type('username', 'Alice');
        type('password', 'recorded-secret');
        document.querySelector('[data-testid="submit"]').click();
      })()`,
    );
    await expect.poll(() => address.inputValue()).toBe(completeUrl);
    await expect
      .poll(() => evaluateBrowser<string>(app, completeUrl, `document.querySelector('#result').textContent`))
      .toBe('done:Alice:recorded-secret:yearly');
    await expect
      .poll(() => evaluateBrowser<boolean>(app, completeUrl, `Boolean(document.querySelector('[data-testid="complete"]'))`))
      .toBe(true);
    const waitSelector = workbar.getByRole('textbox', { name: '等待 CSS 选择器' });
    await waitSelector.fill('[data-testid="complete"]');
    await workbar.getByRole('button', { name: '记录当前可观察等待条件' }).click();

    await workbar.getByRole('button', { name: '停止录制操作流程' }).click();
    await expect(workbar.getByText('等待页面跳转')).toHaveCount(2);
    await expect(workbar.getByText('等待选择器')).toBeVisible();
    const workflowName = workbar.getByRole('textbox', { name: '操作流程名称' });
    await workflowName.fill('Loopback checkout');
    await workbar.getByRole('button', { name: '保存操作流程' }).click();
    await expect(workflowName).toBeHidden();

    const persisted = await readFile(
      path.join(userDataDir, 'workspaces', 'e2e-fixture-turn-narrative', 'browser-workflows.json'),
      'utf8',
    );
    expect(persisted).toContain('Loopback checkout');
    expect(persisted).not.toContain('recorded-secret');
    expect(persisted).not.toContain('page-forged-secret');
    const { workflows: [savedWorkflow] } = JSON.parse(persisted) as {
      workflows: Array<{ actions: Array<{ kind: string; url?: string; checked?: boolean }> }>;
    };
    expect(savedWorkflow.actions.filter((action) => action.kind === 'navigate')).toHaveLength(1);
    expect(savedWorkflow.actions[2]).toMatchObject({ kind: 'wait', url: formUrl });
    expect(savedWorkflow.actions[3]).toMatchObject({ kind: 'check', checked: true });
    expect(savedWorkflow.actions[7]).toMatchObject({ kind: 'wait', url: completeUrl });

    const expandSidebar = page.getByRole('button', { name: '展开侧边栏' });
    if (await expandSidebar.count()) await expandSidebar.click();
    const sidebar = page.getByRole('navigation', { name: '对话列表' });
    await sidebar.getByRole('button', { name: '定时任务', exact: true }).click();
    const moduleSelector = page.locator('.maka-module-hub-selector');
    await moduleSelector.getByRole('button', { name: '操作流程' }).click();
    const workflow = page.locator('.maka-browser-workflow-row').filter({ hasText: 'Loopback checkout' });
    await expect(workflow).toBeVisible();
    await workflow.getByText('查看步骤').click();
    await expect(workflow.getByText(`打开 ${startUrl}`)).toBeVisible();
    const sensitiveValue = workflow.getByRole('textbox', {
      name: /第 \d+ 步的敏感值：test id: password/,
    });
    await sensitiveValue.fill('runtime-secret');

    await page.evaluate(() => {
      const target = window as typeof window & { __browserWorkflowProgress?: Array<{ status: string; current: number; total: number }> };
      target.__browserWorkflowProgress = [];
      window.maka.browser.workflows.onProgress((event) => {
        target.__browserWorkflowProgress?.push({ status: event.status, current: event.current, total: event.total });
      });
    });
    await workflow.getByRole('button', { name: '运行', exact: true }).click();

    await expect
      .poll(() => evaluateBrowser<string>(app, completeUrl, `document.querySelector('#result').textContent`), { timeout: 15_000 })
      .toBe('done:Alice:runtime-secret:yearly');
    const progress = await page.evaluate(
      () => (window as typeof window & { __browserWorkflowProgress?: Array<{ status: string; current: number; total: number }> }).__browserWorkflowProgress ?? [],
    );
    expect(progress[0]).toEqual({ status: 'running', current: 0, total: 9 });
    expect(progress.at(-1)).toEqual({ status: 'completed', current: 9, total: 9 });

    server.makeReplayMissWaitCondition();
    if (await expandSidebar.count()) await expandSidebar.click();
    await sidebar.getByRole('button', { name: '定时任务', exact: true }).click();
    await moduleSelector.getByRole('button', { name: '操作流程' }).click();
    await sensitiveValue.fill('runtime-secret');
    await workflow.getByRole('button', { name: '运行', exact: true }).click();

    await expect(page.getByRole('region', { name: '嵌入式浏览器' })).toBeVisible();
    await expect(page.getByText('操作流程运行失败', { exact: true })).toBeVisible({ timeout: 25_000 });
    await expect(page.getByText('操作流程回放失败', { exact: true })).toHaveCount(0);

    await sidebar.getByRole('button', { name: '定时任务', exact: true }).click();
    await moduleSelector.getByRole('button', { name: '操作流程' }).click();
    await expect(workflow).toBeVisible();
    await workflow.getByRole('button', { name: '删除', exact: true }).click();
    await expect(workflow.getByText('删除“Loopback checkout”？此操作无法撤销。')).toBeVisible();
    await workflow.getByRole('button', { name: '取消', exact: true }).click();
    await expect(workflow.getByText('删除“Loopback checkout”？此操作无法撤销。')).toHaveCount(0);
    await expect(workflow).toBeVisible();
  } finally {
    await server.close();
  }
});
