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

import { cleanup, context, effect, signal, type JSX } from 'nsh';
import type {
  UiContext,
  UiContributionRef,
  UiRuntime,
} from '../../../../../packages/plugin-sdk/src/workbench.js';
import type { InstanceId } from '../../../../../packages/plugin-sdk/src/generated/runtime.js';
import type { CommandEntry } from '../composerCommands';
import { sameValue } from '../../../../../plugins/shared/value';
import { displayText } from '../locale';
import { errorText, renderText } from '../text';

export type Contribution = UiContributionRef;
export type Panel = { contribution: Contribution; input?: unknown; instance: number };
export type PanelRoute = { instance: InstanceId; id: string; input?: unknown };

export const contributionTitle = (item: Contribution) =>
  item.declaration.kind === 'tool_renderer' || item.declaration.kind === 'root'
    ? item.instance.path.join(' / ')
    : displayText(item.declaration.title);

export function createWorkbenchPlugins(
  runtime: UiRuntime<JSX.Element>,
  rootContext: UiContext,
  options: {
    sessionId(): string | null;
    showPanel(): void;
    report(reason: unknown): void;
    restorePanel?: PanelRoute | null;
  },
) {
  const panel = signal<Panel | null>(null);
  let nextPanel = 0;
  let restorePanel = options.restorePanel;
  cleanup(
    runtime.handlePanels((contribution, input) => {
      options.showPanel();
      panel.set({ contribution, input, instance: ++nextPanel });
    }),
  );
  effect(() => {
    const previous = panel();
    const route = previous
      ? {
          instance: previous.contribution.instance.instance,
          id: previous.contribution.id,
          input: previous.input,
        }
      : restorePanel;
    if (!route || !runtime.ready()) return;
    restorePanel = null;
    const contribution = runtime
      .panels()
      .find((item) => item.id === route.id && sameValue(item.instance.instance, route.instance));
    if (!contribution) {
      if (previous) panel.set(null);
    } else if (!previous || previous.contribution.key !== contribution.key) {
      panel.set({ contribution, input: route.input, instance: ++nextPanel });
    }
  });
  return {
    ...runtime,
    context: rootContext,
    panel,
    sessionId: options.sessionId,
    updateError: () => {
      const reason = runtime.updateError();
      return reason === null ? '' : renderText(errorText(reason));
    },
    commands(sessionId = options.sessionId()): CommandEntry[] {
      return runtime.contributions().flatMap<CommandEntry>((contribution) =>
        contribution.declaration.kind === 'command'
          ? [
              {
                id: contribution.key,
                title: displayText(contribution.declaration.title),
                detail: contribution.instance.path.join(' / '),
                trigger: `plugin:${contribution.instance.path.join(':')}:${contribution.id}`,
                async run() {
                  try {
                    return await runtime.invoke(
                      contribution,
                      { sessionId },
                      () => options.sessionId() === sessionId,
                    );
                  } catch (reason) {
                    options.report(reason);
                    return false;
                  }
                },
              },
            ]
          : [],
      );
    },
    panelRoute(): PanelRoute | null {
      const current = panel();
      return current
        ? {
            instance: current.contribution.instance.instance,
            id: current.contribution.id,
            input: current.input,
          }
        : null;
    },
    closePanel(instance: number) {
      if (panel()?.instance === instance) panel.set(null);
    },
  };
}
export type WorkbenchPlugins = ReturnType<typeof createWorkbenchPlugins>;
export const pluginContext = context<WorkbenchPlugins | null>(null);
