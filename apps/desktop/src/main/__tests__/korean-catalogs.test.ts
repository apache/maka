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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getArtifactCopy } from '../../renderer/locales/artifact-copy.js';
import { getBrowserCopy } from '../../renderer/locales/browser-copy.js';
import { getDesktopConversationCopy } from '../../renderer/locales/conversation-copy.js';
import { getExternalSessionImportCopy } from '../../renderer/locales/external-session-import-copy.js';
import { getMcpCopy } from '../../renderer/locales/mcp-copy.js';
import { getPlanModeCopy } from '../../renderer/locales/plan-mode-copy.js';
import { getBotSettingsCopy } from '../../renderer/locales/settings-bot-copy.js';
import { getDailyReviewSettingsCopy } from '../../renderer/locales/settings-daily-review-copy.js';
import { getDataSettingsCopy } from '../../renderer/locales/settings-data-copy.js';
import { getHealthCenterCopy } from '../../renderer/locales/settings-health-copy.js';
import type { HealthSignal } from '@maka/core/health';
import { getMemorySettingsCopy } from '../../renderer/locales/settings-memory-copy.js';
import { getSettingsNavigationCopy } from '../../renderer/locales/settings-navigation-copy.js';
import { getSettingsProjectsCopy } from '../../renderer/locales/settings-projects-copy.js';
import { getProviderSettingsCopy } from '../../renderer/features/connection-settings/index.js';
import { getSettingsSharedCopy } from '../../renderer/locales/settings-shared-copy.js';
import { getSubagentSettingsCopy } from '../../renderer/locales/settings-subagents-copy.js';
import { getSettingsTasksCopy } from '../../renderer/locales/settings-tasks-copy.js';
import { settingsTestResultMessage } from '../../renderer/locales/settings-test-result-copy.js';
import type { SettingsTestResult } from '@maka/core/settings';
import { getUsageSettingsCopy } from '../../renderer/locales/settings-usage-copy.js';
import { getWebSearchSettingsCopy } from '../../renderer/locales/settings-web-search-copy.js';
import { getSettingsPreferencesCopy } from '../../renderer/locales/settings-preferences-copy.js';

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'function' || value === null || typeof value !== 'object') return [];
  return Object.values(value).flatMap(collectStrings);
}

test('all Desktop slice-2 catalogs expose visibly Korean copy', () => {
  const values = [
    getArtifactCopy('ko').pane.copy,
    getBrowserCopy('ko').title,
    getDesktopConversationCopy('ko').actions.conversationErrorTitle,
    getExternalSessionImportCopy('ko').sourceLabel,
    getMcpCopy('ko').page.setupTitle,
    getPlanModeCopy('ko').proposal.execute,
    getBotSettingsCopy('ko').overview.reload,
    getDailyReviewSettingsCopy('ko').aria,
    getDataSettingsCopy('ko').backupTitle,
    getHealthCenterCopy('ko').title,
    getMemorySettingsCopy('ko').text.title,
    getSettingsNavigationCopy('ko').sections.general.label,
    getSettingsProjectsCopy('ko').runtimeHost.title,
    getProviderSettingsCopy('ko').detail.modelKey,
    getSettingsSharedCopy('ko').modalLabel,
    getSubagentSettingsCopy('ko').section.title,
    getSettingsTasksCopy('ko').listAria,
    getUsageSettingsCopy('ko').details,
    getWebSearchSettingsCopy('ko').search,
  ];

  for (const value of values) assert.match(value, /[가-힣]/u);
  const proxyDisabled: SettingsTestResult = { ok: false, code: 'proxy_disabled', message: '' };
  assert.match(settingsTestResultMessage(proxyDisabled, 'ko'), /[가-힣]/u);
});

test('Korean catalog additions do not leak Korean into English or leave key dynamic copy in English', () => {
  const catalogs = [
    getArtifactCopy,
    getBrowserCopy,
    getDesktopConversationCopy,
    getExternalSessionImportCopy,
    getMcpCopy,
    getPlanModeCopy,
    getBotSettingsCopy,
    getDailyReviewSettingsCopy,
    getDataSettingsCopy,
    getHealthCenterCopy,
    getMemorySettingsCopy,
    getSettingsNavigationCopy,
    getSettingsProjectsCopy,
    getProviderSettingsCopy,
    getSettingsSharedCopy,
    getSubagentSettingsCopy,
    getSettingsTasksCopy,
    getUsageSettingsCopy,
    getWebSearchSettingsCopy,
  ];
  for (const getCopy of catalogs) {
    assert.equal(collectStrings(getCopy('en')).some((value) => /[가-힣]/u.test(value)), false);
  }

  assert.match(getMemorySettingsCopy('ko').text.localFile, /[가-힣]/u);
  const provider = getProviderSettingsCopy('ko');
  for (const value of [
    provider.detail.status,
    provider.detail.filterModels,
    provider.detail.declareCapabilities,
    provider.shared.filterMatches(2),
    provider.panel.groups.recommended,
    provider.panel.connectionsHelp,
    provider.panel.browseAll,
    provider.add.stepsAria,
    provider.add.onboardingSelectedCount(2, 3),
    provider.add.onboardingDefaultModelHelp,
    provider.oauthFlow.refreshFailed,
  ]) {
    assert.match(value, /[가-힣]/u);
  }
  assert.match(getHealthCenterCopy('ko').signalMessage({
    id: 'connection:test:runtime',
    label: '테스트',
    scope: 'llm_connection',
    layer: 'runtime_probe',
    status: 'ok',
    source: 'runtime_probe',
    checkedAt: 0,
    message: '',
  } satisfies HealthSignal), /[가-힣]/u);
  const health = getHealthCenterCopy('ko');
  assert.equal(health.signalLabel({
    id: 'capability:activity_recorder',
    label: 'Activity Recorder',
    scope: 'capability',
    layer: 'feature',
    status: 'ok',
    source: 'capability_snapshot',
    checkedAt: 0,
    message: '',
  } satisfies HealthSignal), '활동 기록');
  assert.equal(health.signalLabel({
    id: 'capability:bot:telegram',
    label: 'telegram Bot',
    scope: 'bot',
    layer: 'feature',
    status: 'ok',
    source: 'capability_snapshot',
    checkedAt: 0,
    message: '',
  } satisfies HealthSignal), 'telegram 봇');
  const inspector = getDesktopConversationCopy('ko').inspector;
  assert.equal(inspector.callKind('daily_review'), '일일 검토');
  assert.equal(inspector.permissionDecision('allow'), '허용됨');
  assert.equal(inspector.retries(2), '2회 재시도');
  assert.equal(getMcpCopy('ko').toast.importedDetail(2), '2 서버를 가져왔습니다.');
  assert.equal(getMcpCopy('ko').row.tools(2), '2개 도구');
  assert.equal(getArtifactCopy('ko').preview.externalLinks(2), '이 미리보기에서는 외부 링크가 비활성화되었습니다. · 외부 링크 2개');
  assert.equal(getUsageSettingsCopy('ko').recordCount(2), '2개 기록');
  assert.deepEqual(getSettingsPreferencesCopy('en').personalization.localeOptions.at(-1), ['ko', '한국어']);
  assert.deepEqual(getSettingsPreferencesCopy('zh').personalization.localeOptions.at(-1), ['ko', '한국어']);
});

test('Korean representative surfaces preserve interpolation', () => {
  const plan = getPlanModeCopy('ko');
  const conversation = getDesktopConversationCopy('ko');

  assert.equal(plan.abandonConfirmation.description('Release plan'), '“Release plan”의 실행 기록은 유지되지만 다시 시작할 수 없습니다.');
  assert.equal(plan.execution.stepCount(2, 3), '2/3단계');
  assert.equal(conversation.actions.branchCreatedDescription('Release branch'), '새 작업: Release branch');
});
