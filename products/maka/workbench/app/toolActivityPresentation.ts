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

import type { DisplayText } from '../../../../packages/plugin-sdk/src/index.js';
import type { Icon } from './Icon';
import { displayText, tr } from './locale';
import { cardFamily, record, type ToolProjection, type ToolSection } from './toolCards';
import { sessionToolPresentations } from './toolSessionActivity';
import { deploymentToolPresentations } from './toolDeploymentActivity';
import { nativeToolPresentations } from './toolNativeActivity';
import { serviceToolPresentations } from './toolServiceActivity';

type ToolIcon = Parameters<typeof Icon>[0]['name'];
export type ActivityFieldContext = {
  returned: boolean;
  sessionTitle?(id: string): string | undefined;
};

type ActivityField = (
  value: unknown,
  context: ActivityFieldContext,
) => ToolSection[] | ToolProjection | null;

export type ActivityPresentation = {
  title: () => string;
  icon: ToolIcon;
  arguments?: ActivityField;
  result?: ActivityField;
};

const workspaceTitles = {
  read: ['Read file', 'file'],
  write: ['Write file', 'edit'],
  edit: ['Edit file', 'edit'],
  patch: ['Patch file', 'edit'],
  glob: ['Find files', 'search'],
  grep: ['Search files', 'search'],
  execute: ['Run command', 'terminal'],
  processRead: ['Read process output', 'terminal'],
  stdin: ['Send process input', 'terminal'],
  stop: ['Stop process', 'terminal'],
  fetch: ['Read web page', 'link'],
  webSearch: ['Search the web', 'search'],
} as const;

const presentations: ReadonlyMap<string, ActivityPresentation> = new Map(
  Object.entries({
    ...sessionToolPresentations,
    ...deploymentToolPresentations,
    ...nativeToolPresentations,
    ...serviceToolPresentations,
  }),
);

export function activityPresentation(key: string | null | undefined) {
  return key ? presentations.get(key) : undefined;
}

export function activityTitle(
  tool:
    | {
        title?: DisplayText | null;
        name?: string;
        presentation?: string | null;
      }
    | null
    | undefined,
): string {
  if (tool?.title) return displayText(tool.title);
  const descriptor = activityPresentation(tool?.presentation);
  if (descriptor) return descriptor.title();
  const family = cardFamily(tool?.presentation);
  return family ? tr(workspaceTitles[family][0]) : (tool?.name ?? tr('Tool'));
}

export function activityIcon(key: string | null | undefined): ToolIcon {
  const descriptor = activityPresentation(key);
  if (descriptor) return descriptor.icon;
  const family = cardFamily(key);
  return family ? workspaceTitles[family][1] : 'activity';
}

export function activityFailure(original: unknown): ToolProjection | null {
  const value = record(original);
  const receipt = record(value?.receipt);
  const outcome = receipt?.kind === 'recorded' ? record(receipt.outcome) : undefined;
  const failure = outcome?.kind === 'returned' ? record(outcome.result) : undefined;
  const message =
    value?.kind === 'failed'
      ? value.message
      : failure?.kind === 'failure'
        ? failure.diagnostic
        : outcome?.kind === 'not_executed'
          ? tr('This action was not run.')
          : value?.kind === 'text'
            ? value.text
            : original;
  if (typeof message !== 'string' || !message.trim()) return null;
  return {
    kind: 'failure',
    message: message === 'agent_session_unavailable' ? tr('Conversation is unavailable') : message,
  };
}

export function activityProjection(
  presentation: ActivityPresentation,
  field: 'arguments' | 'result',
  original: unknown,
  context: ActivityFieldContext,
): ToolProjection | null {
  let value = original;
  if (field === 'result') {
    const envelope = record(original);
    if (envelope?.kind === 'failed' && typeof envelope.message === 'string')
      return { kind: 'failure', message: envelope.message };
    if (envelope?.kind === 'completed' && 'value' in envelope) value = envelope.value;
  }
  const projected = presentation[field]?.(value, context);
  return Array.isArray(projected) ? { kind: 'sections', sections: projected } : (projected ?? null);
}
