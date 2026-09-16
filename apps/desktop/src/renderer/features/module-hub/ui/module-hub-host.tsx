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

import {
  DailyReviewPage,
  ModuleHubSelector,
  ScheduledTasksPage,
  SkillsPage,
  getSharedUiCopy,
  useUiLocale,
  type ModuleHubHeader,
} from '@maka/ui';
import { McpPage } from '../../../mcp-page.js';
import type { ModuleHubHostModel } from '../controller/use-module-hub-controller.js';
import { resolveModuleHubHostRoute } from '../controller/module-hub-route.js';
import { useModuleHubHostModel } from './module-hub-provider.js';

/** Selects and mounts exactly one Module Hub leaf for the Shell selection. */
export function ModuleHubHost() {
  return <ModuleHubHostView model={useModuleHubHostModel()} />;
}

/** Environment-free view seam for focused tests and Storybook. */
export function ModuleHubHostView({ model }: { model: ModuleHubHostModel }) {
  const copy = getSharedUiCopy(useUiLocale()).moduleHubs;
  const selection = model.selection;
  const route = resolveModuleHubHostRoute(selection);

  if (route === 'skills' || route === 'mcp') {
    const header: ModuleHubHeader = {
      title: copy.extensions.title,
      subtitle: copy.extensions.description,
      badge: (
        <ModuleHubSelector
          hub="extensions"
          value={route}
          onChange={(module) =>
            model.selectModule({ section: 'extensions', module })
          }
        />
      ),
    };
    if (route === 'mcp') {
      // Explicit leaf-owner exception: MCP keeps its existing page-owned
      // controller and direct bridge; Module Hub only selects and mounts it.
      return <McpPage hubHeader={header} />;
    }
    return (
      <SkillsPage
        hubHeader={header}
        scheduledTasks={model.scheduledTasks.scheduledTasks}
        {...model.skills}
      />
    );
  }

  if (route === 'scheduled-tasks' || route === 'daily-review') {
    const header: ModuleHubHeader = {
      title: copy.automations.title,
      subtitle: copy.automations.description,
      badge: (
        <ModuleHubSelector
          hub="automations"
          value={route}
          onChange={(module) =>
            model.selectModule({ section: 'automations', module })
          }
        />
      ),
    };
    if (route === 'scheduled-tasks') {
      const keepAwake = model.keepSystemAwake;
      const tasks = model.scheduledTasks;
      return (
        <ScheduledTasksPage
          hubHeader={header}
          tasks={tasks.scheduledTasks}
          createRequestNonce={tasks.createRequestNonce}
          onCreateRequestHandled={tasks.handleCreateRequest}
          keepSystemAwake={
            keepAwake.supported ? keepAwake.keepSystemAwake : undefined
          }
          onKeepSystemAwakeChange={
            keepAwake.supported ? keepAwake.setKeepSystemAwake : undefined
          }
          onRefresh={tasks.refreshSurface}
          onCreate={tasks.create}
          onUpdate={tasks.update}
          onToggle={tasks.toggle}
          onTriggerNow={tasks.triggerNow}
          onSnooze={tasks.snooze}
          onClearRunHistory={tasks.clearRunHistory}
          onDelete={tasks.delete}
        />
      );
    }
    const dailyReview = model.dailyReview;
    return (
      <DailyReviewPage
        hubHeader={header}
        bridge={dailyReview.bridge}
        onSelectSession={model.openSession}
        onCopyMarkdown={dailyReview.copyMarkdown}
        onAppendMarkdown={dailyReview.appendMarkdown}
        onSaveMarkdown={dailyReview.saveMarkdown}
      />
    );
  }

  return null;
}
