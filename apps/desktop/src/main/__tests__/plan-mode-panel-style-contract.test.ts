import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const repoRoot = resolve(import.meta.dirname, '../../../../..');
const rendererRoot = resolve(repoRoot, 'apps', 'desktop', 'src', 'renderer');

describe('Plan Mode proposal presentation', () => {
  it('renders proposal steps and risks as individual items', async () => {
    const source = await readFile(resolve(rendererRoot, 'plan-mode-panel.tsx'), 'utf8');

    assert.match(source, /className="plan-proposal-steps"/);
    assert.match(source, /proposal\.steps\.map\(\(step, index\)/);
    assert.match(source, /className="plan-proposal-step-number"/);
    assert.match(source, /className="plan-proposal-step-content"/);
    assert.match(source, /<strong>\{step\.title\}<\/strong>/);
    assert.match(source, /<p>\{step\.description\}<\/p>/);
    assert.match(source, /proposal\.risks\.map\(\(risk, index\)/);
    assert.match(source, /reviewable && \(/);
    assert.match(source, /proposalStatusLabel\(proposal\.status\)/);
  });

  it('uses Maka theme tokens instead of fixed light-mode colors', async () => {
    const styles = await readFile(resolve(rendererRoot, 'styles/plan-mode.css'), 'utf8');

    assert.match(styles, /background: var\(--background-elevated\)/);
    assert.match(styles, /color: var\(--foreground\)/);
    assert.match(styles, /solid var\(--border\)/);
    assert.doesNotMatch(styles, /#[\da-f]{3,8}\b/i);
  });

  it('anchors every proposal to its historical turn and keeps execution above the composer', async () => {
    const appShell = await readFile(resolve(rendererRoot, 'app-shell.tsx'), 'utf8');
    const chatView = await readFile(
      resolve(repoRoot, 'packages', 'ui', 'src', 'chat-view.tsx'),
      'utf8',
    );

    assert.match(appShell, /afterTurnId: proposal\.turnId/);
    assert.match(appShell, /conversationItems=\{planConversationItems\}/);
    assert.match(appShell, /<PlanExecutionPanel planMode=\{planMode\} \/>[\s\S]*?<ChatComposerRegion/);
    assert.match(
      chatView,
      /conversationItemsByTurn\.get\(turn\.turnId\)/,
    );
  });

  it('refreshes execution state after a durable Plan tool result', async () => {
    const source = await readFile(resolve(rendererRoot, 'plan-mode-panel.tsx'), 'utf8');

    assert.match(source, /isPlanToolResult\(event\)/);
    assert.match(source, /kind === 'plan_progress_updated'/);
    assert.match(source, /className="plan-execution-steps"/);
    assert.match(source, /executionStepStatusLabel\(step\.status\)/);
    assert.match(source, /<span>\{step\.title\}<\/span>/);
  });

  it('keeps execution details collapsed by default and offers interrupted actions', async () => {
    const [source, preload, bridge, main] = await Promise.all([
      readFile(resolve(rendererRoot, 'plan-mode-panel.tsx'), 'utf8'),
      readFile(resolve(repoRoot, 'apps', 'desktop', 'src', 'preload', 'preload.ts'), 'utf8'),
      readFile(
        resolve(repoRoot, 'apps', 'desktop', 'src', 'preload', 'bridge-contract.d.ts'),
        'utf8',
      ),
      readFile(resolve(repoRoot, 'apps', 'desktop', 'src', 'main', 'sessions-ipc-main.ts'), 'utf8'),
    ]);

    assert.match(source, /const \[expanded, setExpanded\] = useState\(false\)/);
    assert.match(source, /aria-expanded=\{expanded\}/);
    assert.match(source, /\{expanded && \(/);
    // #1565 PR 3: Astryx Button renders visible text from the `label` prop.
    assert.match(source, /label="恢复执行"/);
    assert.match(source, /label="放弃计划"/);
    assert.match(source, /toastApi\.confirm\(\{/);
    assert.match(source, /window\.maka\.sessions\.abandonPlanExecution/);
    assert.match(preload, /abandonPlanExecution\(sessionId: string, executionId: string\)/);
    assert.match(preload, /ipcRenderer\.invoke\('plan-mode:abandonExecution', sessionId, executionId\)/);
    assert.match(bridge, /abandonPlanExecution\(sessionId: string, executionId: string\)/);
    assert.match(main, /ipcMain\.handle\('plan-mode:abandonExecution'/);
  });
});
