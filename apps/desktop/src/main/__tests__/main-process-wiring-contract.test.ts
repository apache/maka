import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

const mainSource = readFileSync(join(repoRoot, 'apps/desktop/src/main/main.ts'), 'utf8');

const extractedIpcRegistrars = [
  ['registerMemoryIpc', './memory-ipc-main'],
  ['registerSubscriptionIpc', './subscription-ipc-main'],
  ['registerBrowserIpc', './browser-ipc-main'],
  ['registerConnectionsIpc', './connections-ipc-main'],
  ['registerConfigIpc', './config-ipc-main'],
  ['registerNotificationsIpc', './notifications-ipc-main'],
  ['registerPlanReminderIpc', './plan-reminders-ipc-main'],
  ['registerWorkspaceResourcesIpc', './workspace-resources-ipc-main'],
  ['registerDailyReviewIpc', './daily-review-ipc-main'],
  ['registerUsageIpc', './usage-ipc-main'],
  ['registerWebSearchIpc', './web-search-ipc-main'],
  ['registerAppIpc', './app-ipc-main'],
  ['registerGitIpc', './git-ipc-main'],
  ['registerWorkspaceSearchIpc', './workspace-search-ipc-main'],
  ['registerWorkspaceInstructionsIpc', './workspace-instructions-ipc-main'],
  ['registerOnboardingIpc', './onboarding-ipc-main'],
  ['registerSessionEntryIpc', './session-entry-ipc-main'],
  ['registerAgentGraphIpc', './agent-graph-ipc-main'],
  ['registerSessionsIpc', './sessions-ipc-main'],
  ['registerPermissionsIpc', './permissions-ipc-main'],
  ['registerSettingsIpc', './settings-ipc-main'],
  ['registerGatewayIpc', './gateway-ipc-main'],
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('main process extracted IPC wiring contract', () => {
  it('imports and invokes every extracted IPC registrar from main.ts', () => {
    for (const [registrar, modulePath] of extractedIpcRegistrars) {
      assert.match(
        mainSource,
        new RegExp(`import \\{ ${registrar} \\} from '${escapeRegExp(modulePath)}\\.js';`),
        `${registrar} must be imported by main.ts`,
      );
      assert.match(
        mainSource,
        new RegExp(`\\b${registrar}\\(\\{`),
        `${registrar} must be invoked by main.ts`,
      );
    }
  });
});
