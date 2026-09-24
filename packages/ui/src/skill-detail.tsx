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
  Button,
  Divider,
  HStack,
  StackItem,
  Switch,
  Text,
  VStack,
} from '@astryxdesign/core';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import type { ManagedSkillUpdatePreview, SkillEntry } from './module-panel-types.js';
import type { ModulePageDetail } from './primitives/module-page.js';
import {
  formatSkillLibraryDescription,
  formatSkillStatusLabel,
  skillContextStatus,
  skillStatusDotLabel,
} from './skill-status.js';
import type { SkillsCopy } from './skills-copy.js';

const SKILL_UPDATE_PREVIEW_MAX_LINES = 80;

function previewText(content: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const clipped = lines.slice(0, SKILL_UPDATE_PREVIEW_MAX_LINES).join('\n');
  return lines.length > SKILL_UPDATE_PREVIEW_MAX_LINES ? `${clipped}\n...` : clipped;
}

export interface SkillDetailActions {
  /** One page-level action is in flight; every control here idles with it. */
  busy?: boolean;
  opening?: boolean;
  reviewing?: boolean;
  onUse?(): void;
  onSetEnabled?(enabled: boolean): void;
  onTogglePinned?(): void;
  onOpen?(): void;
  onPreviewUpdate?(): void;
  onApplyUpdate?(): void;
  onCancelUpdate?(): void;
  onDelete?(): void;
}

export function skillUpdateReviewDetail(
  preview: ManagedSkillUpdatePreview,
  copy: SkillsCopy,
  actions: SkillDetailActions,
): ModulePageDetail {
  return {
    title: copy.review.title,
    subtitle: preview.skill.name,
    content: (
      <VStack gap={4} role="group" aria-label={copy.review.ariaLabel}>
        <div className="maka-skill-governance-summary">
          <span>{formatSkillStatusLabel(preview.skill, copy)}</span>
          <span>{preview.skill.managedSourceId ? copy.review.source(preview.skill.managedSourceId) : copy.review.managedSource}</span>
          <span>{preview.skill.hasManagedBaseline ? copy.review.hasBaseline : copy.review.missingBaseline}</span>
          <span>{copy.review.lineTransition(preview.summary.currentLineCount, preview.summary.sourceLineCount)}</span>
          <span>{copy.review.changedLines(preview.summary.changedLineCount)}</span>
        </div>
        {preview.skill.managedUpdateStatus === 'local_modified' && (
          <p className="maka-skill-governance-warning">{copy.review.warning}</p>
        )}
        <div className="maka-skill-diff-grid">
          <div>
            <span>{copy.review.workspace}</span>
            <pre>{previewText(preview.currentContent)}</pre>
          </div>
          <div>
            <span>{copy.review.sourceVersion}</span>
            <pre>{previewText(preview.sourceContent)}</pre>
          </div>
        </div>
      </VStack>
    ),
    footer: (
      <HStack gap={2} hAlign="end">
        <Button variant="secondary" onClick={actions.onCancelUpdate} isDisabled={actions.busy} label={copy.review.cancel} />
        <Button
          variant="primary"
          onClick={actions.onApplyUpdate}
          isDisabled={actions.busy || !actions.onApplyUpdate}
          label={preview.skill.managedUpdateStatus === 'local_modified' ? copy.review.overwrite : copy.review.update}
        />
      </HStack>
    ),
  };
}

export function skillDetail(skill: SkillEntry, copy: SkillsCopy, actions: SkillDetailActions): ModulePageDetail {
  const contextStatus = skillContextStatus(skill);
  const canToggle =
    Boolean(actions.onSetEnabled)
    && skill.runtimeStatus !== 'state_error'
    && contextStatus !== 'invalid';
  const reviewableManagedUpdate =
    skill.managedUpdateStatus === 'update_available' || skill.managedUpdateStatus === 'local_modified';
  const tools = skill.declaredTools ?? [];
  const description = formatSkillLibraryDescription(skill, copy);
  const canDelete = Boolean(actions.onDelete) && skill.manageable !== false;

  return {
    title: skill.name,
    subtitle: skillStatusDotLabel(skill, copy),
    content: (
      <VStack gap={4}>
        {description ? <Text type="body">{description}</Text> : null}
        <HStack gap={2} vAlign="center" wrap="wrap">
          {canToggle ? (
            <StackItem size="fill">
              <Switch
                value={skill.enabled}
                isDisabled={actions.busy}
                label={copy.detail.enabled}
                onChange={(next) => actions.onSetEnabled?.(next)}
              />
            </StackItem>
          ) : <StackItem size="fill" />}
          {actions.onTogglePinned ? (
            <Button
              size="sm"
              variant="secondary"
              label={skill.pinned ? copy.row.unpinTitle : copy.row.pinTitle}
              onClick={actions.onTogglePinned}
              isDisabled={actions.busy || skill.runtimeStatus === 'state_error' || contextStatus === 'invalid'}
            />
          ) : null}
          {reviewableManagedUpdate && actions.onPreviewUpdate ? (
            <Button
              size="sm"
              variant="secondary"
              label={actions.reviewing
                ? copy.row.reviewing
                : skill.managedUpdateStatus === 'local_modified' ? copy.row.viewDiff : copy.row.viewUpdate}
              onClick={actions.onPreviewUpdate}
              isDisabled={actions.busy}
            />
          ) : null}
        </HStack>
        <Divider />
        <MetadataList columns="single" label={{ position: 'start', width: 88 }}>
          <MetadataListItem label={copy.detail.idLabel}>
            <Text type="body"><code>{skill.id}</code></Text>
          </MetadataListItem>
          {skill.scope ? (
            <MetadataListItem label={copy.detail.scopeLabel}>
              <Text type="body">{copy.context.scope[skill.scope]}</Text>
            </MetadataListItem>
          ) : null}
          <MetadataListItem label={copy.detail.sourceLabel}>
            <Text type="body">{formatSkillStatusLabel(skill, copy)}</Text>
          </MetadataListItem>
          {tools.length > 0 ? (
            <MetadataListItem label={copy.detail.toolsLabel}>
              <Text type="body">{tools.join(', ')}</Text>
            </MetadataListItem>
          ) : null}
          <MetadataListItem label={copy.detail.pathLabel}>
            <Text type="body"><code>{skill.path}</code></Text>
          </MetadataListItem>
        </MetadataList>
      </VStack>
    ),
    footer: (
      <HStack gap={2} vAlign="center">
        {canDelete ? (
          <Button variant="destructive" label={copy.row.delete} onClick={actions.onDelete} isDisabled={actions.busy} />
        ) : null}
        <StackItem size="fill" />
        {actions.onOpen ? (
          <Button
            variant="secondary"
            label={actions.opening ? copy.row.opening : copy.row.openTitle}
            onClick={actions.onOpen}
            isDisabled={actions.busy}
          />
        ) : null}
        {actions.onUse && skill.enabled && contextStatus !== 'shadowed' ? (
          <Button variant="primary" label={copy.row.use} onClick={actions.onUse} isDisabled={actions.busy} />
        ) : null}
      </HStack>
    ),
  };
}
