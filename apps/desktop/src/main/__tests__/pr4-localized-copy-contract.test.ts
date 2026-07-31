import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { applyAssistantComplete, getDailyReviewCopy, getPlanReminderCopy, getSharedUiCopy, getSkillsCopy, modelMenuGroups } from '@maka/ui';
import { getBrowserCopy } from '../../renderer/locales/browser-copy.js';
import { getArtifactCopy } from '../../renderer/locales/artifact-copy.js';
import { getMcpCopy } from '../../renderer/locales/mcp-copy.js';
import { getMcpCatalog } from '../../renderer/mcp-catalog.js';
import { getPermissionCenterCopy } from '../../renderer/locales/permission-center-copy.js';
import { getDataSettingsCopy } from '../../renderer/locales/settings-data-copy.js';
import { getUsageSettingsCopy } from '../../renderer/locales/settings-usage-copy.js';
import { getVoiceSettingsCopy } from '../../renderer/locales/settings-voice-copy.js';
import { getWebSearchSettingsCopy } from '../../renderer/locales/settings-web-search-copy.js';
import { getDailyReviewSettingsCopy } from '../../renderer/locales/settings-daily-review-copy.js';
import { getHealthCenterCopy } from '../../renderer/locales/settings-health-copy.js';
import { getMemorySettingsCopy } from '../../renderer/locales/settings-memory-copy.js';
import { getProviderSettingsCopy } from '../../renderer/locales/settings-provider-copy.js';
import { getBotSettingsCopy } from '../../renderer/locales/settings-bot-copy.js';
import { getShellRemainingCopy } from '../../renderer/locales/shell-remaining-copy.js';
import {
  findInlineCjkLiterals,
  findSilentCatalogFallbacks,
  formatSourceViolations,
} from './localized-source-contract-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

const PR4_SHARED_UI_PRESENTATION_FILES = [
  'packages/ui/src/capability-audit-strip.tsx',
  'packages/ui/src/artifact-preview-registry.ts',
  'packages/ui/src/assistant-stream.ts',
  'packages/ui/src/chat-model-helpers.ts',
  'packages/ui/src/chat-model-switcher.tsx',
  'packages/ui/src/daily-review-helpers.ts',
  'packages/ui/src/daily-review-panel.tsx',
  'packages/ui/src/markdown-body.tsx',
  'packages/ui/src/model-picker.tsx',
  'packages/ui/src/module-pages.tsx',
  'packages/ui/src/plan-reminder-form-dialog.tsx',
  'packages/ui/src/plan-reminder-helpers.ts',
  'packages/ui/src/plan-reminder-panel.tsx',
  'packages/ui/src/skills-panel.tsx',
  'packages/ui/src/task-ledger-panel.tsx',
  'packages/ui/src/thinking-stream.ts',
  'packages/ui/src/tool-output-stream.ts',
  'packages/ui/src/toast.tsx',
  'packages/ui/src/ui.tsx',
  'packages/ui/src/use-mention-popup.ts',
] as const;

const PR4_SHARED_UI_CATALOG_FILES = [
  'packages/ui/src/daily-review-copy.ts',
  'packages/ui/src/plan-reminder-copy.ts',
  'packages/ui/src/shared-ui-copy.ts',
  'packages/ui/src/skills-copy.ts',
] as const;

const PR4_DESKTOP_PRESENTATION_FILES = [
  'apps/desktop/src/renderer/artifact-pane.tsx',
  'apps/desktop/src/renderer/artifact-preview.tsx',
  'apps/desktop/src/renderer/artifact-preview-registry-shell.tsx',
  'apps/desktop/src/renderer/browser-panel.tsx',
  'apps/desktop/src/renderer/mcp-import.ts',
  'apps/desktop/src/renderer/mcp-page.tsx',
  'apps/desktop/src/renderer/settings/permission-center-page.tsx',
  'apps/desktop/src/renderer/settings/data-settings-page.tsx',
  'apps/desktop/src/renderer/settings/usage-settings-page.tsx',
  'apps/desktop/src/renderer/settings/voice-settings-page.tsx',
  'apps/desktop/src/renderer/settings/web-search-settings-page.tsx',
  'apps/desktop/src/renderer/settings/daily-review-settings-page.tsx',
  'apps/desktop/src/renderer/settings/health-center-page.tsx',
  'apps/desktop/src/renderer/settings/memory-settings-page.tsx',
  'apps/desktop/src/renderer/settings/memory-settings-sections.tsx',
  'apps/desktop/src/renderer/settings/memory-entry-list.tsx',
  'apps/desktop/src/renderer/settings/memory-settings-view-model.ts',
  'apps/desktop/src/renderer/settings/memory-settings-labels.ts',
  'apps/desktop/src/renderer/settings/use-memory-settings-controller.ts',
  'apps/desktop/src/renderer/settings/use-workspace-instructions-controller.ts',
  'apps/desktop/src/renderer/settings/ProvidersPanel.tsx',
  'apps/desktop/src/renderer/settings/provider-add-form.tsx',
  'apps/desktop/src/renderer/settings/provider-catalog.tsx',
  'apps/desktop/src/renderer/settings/provider-connection-detail.tsx',
  'apps/desktop/src/renderer/settings/provider-connection-status.ts',
  'apps/desktop/src/renderer/settings/provider-display.tsx',
  'apps/desktop/src/renderer/settings/provider-oauth-section.tsx',
  'apps/desktop/src/renderer/settings/provider-panel-shared.ts',
  'apps/desktop/src/renderer/settings/claude-subscription-card.tsx',
  'apps/desktop/src/renderer/settings/use-oauth-login-flow.ts',
  'apps/desktop/src/renderer/settings/bot-chat-detail.tsx',
  'apps/desktop/src/renderer/settings/bot-chat-overview.tsx',
  'apps/desktop/src/renderer/settings/bot-chat-settings-page.tsx',
  'apps/desktop/src/renderer/settings/bot-chat-shared.tsx',
  'apps/desktop/src/renderer/settings/bot-onboarding-modal.tsx',
  'apps/desktop/src/renderer/settings/bot-wechat-login.tsx',
  'apps/desktop/src/renderer/app-shell-plan-actions.ts',
  'apps/desktop/src/renderer/app-shell-effects.ts',
  'apps/desktop/src/renderer/app-shell-overlays.tsx',
  'apps/desktop/src/renderer/daily-review-actions.ts',
  'apps/desktop/src/renderer/app-shell-daily-review-bridge.ts',
  'apps/desktop/src/renderer/use-shell-connections.ts',
  'apps/desktop/src/renderer/use-session-tasks.ts',
  'apps/desktop/src/renderer/session-project-grouping.ts',
  'apps/desktop/src/renderer/model-catalog-choices.ts',
  'apps/desktop/src/renderer/conversation-markdown.ts',
] as const;

const PR4_DESKTOP_CATALOG_FILES = [
  'apps/desktop/src/renderer/locales/artifact-copy.ts',
  'apps/desktop/src/renderer/locales/browser-copy.ts',
  'apps/desktop/src/renderer/locales/mcp-copy.ts',
  'apps/desktop/src/renderer/locales/permission-center-copy.ts',
  'apps/desktop/src/renderer/locales/settings-data-copy.ts',
  'apps/desktop/src/renderer/locales/settings-usage-copy.ts',
  'apps/desktop/src/renderer/mcp-catalog.ts',
  'apps/desktop/src/renderer/locales/settings-voice-copy.ts',
  'apps/desktop/src/renderer/locales/settings-web-search-copy.ts',
  'apps/desktop/src/renderer/locales/settings-daily-review-copy.ts',
  'apps/desktop/src/renderer/locales/settings-health-copy.ts',
  'apps/desktop/src/renderer/locales/settings-memory-copy.ts',
  'apps/desktop/src/renderer/locales/settings-provider-copy.ts',
  'apps/desktop/src/renderer/settings/provider-display-copy.ts',
  'apps/desktop/src/renderer/locales/settings-bot-copy.ts',
  'apps/desktop/src/renderer/locales/shell-remaining-copy.ts',
] as const;

function repoSource(file: string): string {
  return readFileSync(resolve(REPO_ROOT, file), 'utf8');
}

describe('PR4 remaining shared UI copy contract', () => {
  it('selects complete independent copy for both locales', () => {
    assert.equal(getSharedUiCopy('zh').modelPicker.searchPlaceholder, '搜索模型…');
    assert.equal(getSharedUiCopy('en').modelPicker.searchPlaceholder, 'Search models…');
    assert.equal(getSharedUiCopy('en').taskLedger.status.pending, 'Pending');
    assert.equal(getDailyReviewCopy('zh').page.title, '每日回顾');
    assert.equal(getDailyReviewCopy('en').page.title, 'Daily review');
    assert.equal(getPlanReminderCopy('zh').page.title, '定时任务');
    assert.equal(getPlanReminderCopy('en').page.title, 'Scheduled tasks');
    assert.deepEqual(
      [
        getPlanReminderCopy('zh').form.field.cron,
        getPlanReminderCopy('zh').form.field.chatId,
        getPlanReminderCopy('zh').form.field.time,
        getPlanReminderCopy('en').form.field.cron,
        getPlanReminderCopy('en').form.field.chatId,
        getPlanReminderCopy('en').form.field.time,
      ],
      ['Cron', 'Chat ID', '提醒时间', 'Cron', 'Chat ID', 'Reminder time'],
    );
    assert.equal(getSkillsCopy('zh').page.title, '技能');
    assert.equal(getSkillsCopy('en').page.title, 'Skills');
    assert.match(applyAssistantComplete('x'.repeat(100), { maxTotalChars: 40, locale: 'en' }).text, /remaining output truncated/);
    assert.equal(modelMenuGroups([{ connectionSlug: 'custom', providerType: 'openai-compatible', model: 'm', label: 'M' }], 'en')[0]?.heading, 'Custom');
  });

  it('contains no inline user-visible Chinese in migrated shared UI owners', () => {
    const violations = PR4_SHARED_UI_PRESENTATION_FILES.flatMap((file) =>
      findInlineCjkLiterals(repoSource(file), file),
    );
    assert.equal(violations.length, 0, formatSourceViolations(violations));
  });

  it('does not silently fall English copy back to Chinese', () => {
    const violations = PR4_SHARED_UI_CATALOG_FILES.flatMap((file) =>
      findSilentCatalogFallbacks(repoSource(file), file),
    );
    assert.equal(violations.length, 0, formatSourceViolations(violations));
  });
});

describe('PR4 remaining desktop copy contract', () => {
  it('selects complete independent copy for both locales', () => {
    assert.equal(getBrowserCopy('zh').title, '嵌入式浏览器');
    assert.equal(getBrowserCopy('en').title, 'Embedded browser');
    assert.equal(getArtifactCopy('zh').pane.empty, '暂无生成文件');
    assert.equal(getArtifactCopy('en').pane.empty, 'No generated files');
    assert.equal(getMcpCopy('en').page.market, 'Marketplace');
    assert.deepEqual(
      {
        serverId: getMcpCopy('zh').editor.serverId,
        command: getMcpCopy('zh').editor.command,
        arguments: getMcpCopy('zh').editor.arguments,
        workingDirectory: getMcpCopy('zh').editor.workingDirectory,
        environment: getMcpCopy('zh').editor.environment,
        url: getMcpCopy('zh').editor.url,
        headers: getMcpCopy('zh').editor.headers,
        transport: getMcpCopy('zh').editor.transportLabel,
      },
      {
        serverId: '服务器 ID',
        command: '命令',
        arguments: '参数',
        workingDirectory: '工作目录',
        environment: '环境变量',
        url: 'MCP URL',
        headers: 'HTTP 请求头',
        transport: '传输协议',
      },
    );
    assert.deepEqual(
      {
        serverId: getMcpCopy('en').editor.serverId,
        command: getMcpCopy('en').editor.command,
        arguments: getMcpCopy('en').editor.arguments,
        workingDirectory: getMcpCopy('en').editor.workingDirectory,
        environment: getMcpCopy('en').editor.environment,
        url: getMcpCopy('en').editor.url,
        headers: getMcpCopy('en').editor.headers,
        transport: getMcpCopy('en').editor.transportLabel,
      },
      {
        serverId: 'Server ID',
        command: 'Command',
        arguments: 'Arguments',
        workingDirectory: 'Working directory',
        environment: 'Environment',
        url: 'MCP URL',
        headers: 'HTTP headers',
        transport: 'Transport',
      },
    );
    assert.equal(getMcpCatalog('zh').find((entry) => entry.id === 'filesystem')?.name, '本地文件');
    assert.equal(getMcpCatalog('en').find((entry) => entry.id === 'filesystem')?.name, 'Local files');
    assert.equal(getPermissionCenterCopy('zh').title, '权限与能力');
    assert.equal(getPermissionCenterCopy('en').title, 'Permissions and capabilities');
    assert.equal(getDataSettingsCopy('en').rows.workspace, 'Workspace path');
    assert.equal(getUsageSettingsCopy('en').tabs[0], 'Request log');
    assert.equal(getVoiceSettingsCopy('zh').microphone, '麦克风权限');
    assert.equal(getVoiceSettingsCopy('en').microphone, 'Microphone permission');
    assert.equal(getWebSearchSettingsCopy('zh').search, '搜索');
    assert.equal(getWebSearchSettingsCopy('en').search, 'Search');
    assert.equal(getDailyReviewSettingsCopy('zh').generateDaily, '生成每日回顾');
    assert.equal(getDailyReviewSettingsCopy('en').generateDaily, 'Generate Daily Review');
    assert.equal(getHealthCenterCopy('zh').statuses.ok.label, '正常');
    assert.equal(getHealthCenterCopy('en').statuses.ok.label, 'Healthy');
    assert.equal(getMemorySettingsCopy('zh').text.localFile, '本地 MEMORY.md');
    assert.equal(getMemorySettingsCopy('en').text.localFile, 'Local MEMORY.md');
    assert.equal(getProviderSettingsCopy('zh').panel.connected, '已连接');
    assert.equal(getProviderSettingsCopy('en').panel.connected, 'Connected');
    assert.equal(getProviderSettingsCopy('en').shared.lastTest['连接已验证'], 'Connection verified');
    assert.equal(getBotSettingsCopy('zh').overview.active, '正在使用');
    assert.equal(getBotSettingsCopy('en').overview.active, 'In use');
    assert.equal(getBotSettingsCopy('en').onboarding.privacy, 'Credentials stay on this device and are never sent to the renderer or Maka cloud.');
    assert.equal(getShellRemainingCopy('en').projects.ungrouped, 'No project');
  });

  it('contains no inline user-visible Chinese in migrated desktop owners', () => {
    const violations = PR4_DESKTOP_PRESENTATION_FILES.flatMap((file) =>
      findInlineCjkLiterals(repoSource(file), file),
    );
    assert.equal(violations.length, 0, formatSourceViolations(violations));
  });

  it('does not silently fall English copy back to Chinese', () => {
    const violations = PR4_DESKTOP_CATALOG_FILES.flatMap((file) =>
      findSilentCatalogFallbacks(repoSource(file), file),
    );
    assert.equal(violations.length, 0, formatSourceViolations(violations));
  });
});
