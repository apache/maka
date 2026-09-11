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

// packages/ui/src/skill-inspector.tsx
//
// The end-panel inspector for one selected Skill, modelled on
// scheduled-task-inspector.tsx (itself the vendor's incident-console
// archetype): identity + status at the top, the actions that change it,
// then its facts as a MetadataList.
//
// This is where every per-row control moved to. Astryx's List guidance is
// explicit that interactive elements do not belong inside an interactive
// list item — rows are selectable and otherwise inert; the use / enable /
// pin / open / update / delete controls live here, as plain buttons with
// room for real labels instead of entries behind a per-row overflow menu.

import {
  Button,
  Divider,
  Heading,
  HStack,
  StackItem,
  StatusDot,
  Switch,
  Text,
  VStack,
} from '@astryxdesign/core';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import type { ManagedSkillUpdatePreview, SkillEntry } from './module-panel-types.js';
import {
  formatSkillLibraryDescription,
  formatSkillRuntimeLabel,
  formatSkillStatusLabel,
  skillContextStatus,
  skillStatusDotLabel,
  skillStatusDotVariant,
} from './skill-status.js';
import { getSkillsCopy } from './skills-copy.js';
import { useUiLocale } from './locale-context.js';

const SKILL_UPDATE_PREVIEW_MAX_LINES = 80;

function previewText(content: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const clipped = lines.slice(0, SKILL_UPDATE_PREVIEW_MAX_LINES).join('\n');
  return lines.length > SKILL_UPDATE_PREVIEW_MAX_LINES ? `${clipped}\n...` : clipped;
}

export function SkillInspector(props: {
  skill: SkillEntry;
  /** One page-level action is in flight; every control here idles with it. */
  busy?: boolean;
  opening?: boolean;
  reviewing?: boolean;
  /** When set, the inspector trades its detail for the update review. */
  updatePreview?: ManagedSkillUpdatePreview | null;
  onUse?(): void;
  onSetEnabled?(enabled: boolean): void;
  onTogglePinned?(): void;
  onOpen?(): void;
  onPreviewUpdate?(): void;
  onApplyUpdate?(): void;
  onCancelUpdate?(): void;
  onDelete?(): void;
}) {
  const copy = getSkillsCopy(useUiLocale());
  const { skill, updatePreview } = props;
  const contextStatus = skillContextStatus(skill);
  const canToggle =
    Boolean(props.onSetEnabled)
    && skill.runtimeStatus !== 'state_error'
    && contextStatus !== 'invalid';
  const reviewableManagedUpdate =
    skill.managedUpdateStatus === 'update_available' || skill.managedUpdateStatus === 'local_modified';
  const tools = skill.declaredTools ?? [];

  if (updatePreview) {
    return (
      <VStack className="maka-skill-inspector" gap={4} role="group" aria-label={copy.review.ariaLabel}>
        <VStack gap={2}>
          <Heading level={2}>{copy.review.title}</Heading>
          <Text type="supporting" color="secondary">
            {formatSkillStatusLabel(updatePreview.skill, copy)}
          </Text>
        </VStack>
        <div className="maka-skill-governance-summary">
          <span>{updatePreview.skill.name}</span>
          <span>{updatePreview.skill.managedSourceId ? copy.review.source(updatePreview.skill.managedSourceId) : copy.review.managedSource}</span>
          <span>{updatePreview.skill.hasManagedBaseline ? copy.review.hasBaseline : copy.review.missingBaseline}</span>
          <span>{copy.review.lineTransition(updatePreview.summary.currentLineCount, updatePreview.summary.sourceLineCount)}</span>
          <span>{copy.review.changedLines(updatePreview.summary.changedLineCount)}</span>
        </div>
        {updatePreview.skill.managedUpdateStatus === 'local_modified' && (
          <p className="maka-skill-governance-warning">
            {copy.review.warning}
          </p>
        )}
        <div className="maka-skill-diff-grid">
          <div>
            <span>{copy.review.workspace}</span>
            <pre>{previewText(updatePreview.currentContent)}</pre>
          </div>
          <div>
            <span>{copy.review.sourceVersion}</span>
            <pre>{previewText(updatePreview.sourceContent)}</pre>
          </div>
        </div>
        <HStack gap={2} style={{ justifyContent: 'flex-end' }}>
          <Button
            variant="ghost"
            size="sm"
            onClick={props.onCancelUpdate}
            isDisabled={props.busy}
            label={copy.review.cancel}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={props.onApplyUpdate}
            isDisabled={props.busy || !props.onApplyUpdate}
            label={updatePreview.skill.managedUpdateStatus === 'local_modified' ? copy.review.overwrite : copy.review.update}
          />
        </HStack>
      </VStack>
    );
  }

  return (
    <VStack className="maka-skill-inspector" gap={4}>
      <VStack gap={2}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <StatusDot
            variant={skillStatusDotVariant(skill)}
            label={skillStatusDotLabel(skill, copy)}
          />
          <Text type="supporting" color="secondary">
            {skillStatusDotLabel(skill, copy)}
          </Text>
        </HStack>
        <Heading level={2}>{skill.name}</Heading>
        {formatSkillLibraryDescription(skill, copy) ? (
          <Text type="body" color="secondary">{formatSkillLibraryDescription(skill, copy)}</Text>
        ) : null}
      </VStack>

      {canToggle && (
        <HStack gap={3} vAlign="center">
          <StackItem size="fill">
            <Switch
              value={skill.enabled}
              isDisabled={props.busy}
              label={copy.detail.enabled}
              onChange={(next) => props.onSetEnabled?.(next)}
            />
          </StackItem>
        </HStack>
      )}

      <HStack gap={2} wrap="wrap">
        {props.onUse && skill.enabled && contextStatus !== 'shadowed' ? (
          <Button
            size="sm"
            label={copy.row.use}
            onClick={props.onUse}
            isDisabled={props.busy}
          />
        ) : null}
        {props.onOpen ? (
          <Button
            size="sm"
            variant="secondary"
            label={props.opening ? copy.row.opening : copy.row.openTitle}
            onClick={props.onOpen}
            isDisabled={props.busy}
          />
        ) : null}
        {props.onTogglePinned ? (
          <Button
            size="sm"
            variant="secondary"
            label={skill.pinned ? copy.row.unpinTitle : copy.row.pinTitle}
            onClick={props.onTogglePinned}
            isDisabled={props.busy || skill.runtimeStatus === 'state_error' || contextStatus === 'invalid'}
          />
        ) : null}
        {reviewableManagedUpdate && props.onPreviewUpdate ? (
          <Button
            size="sm"
            variant="secondary"
            label={props.reviewing
              ? copy.row.reviewing
              : skill.managedUpdateStatus === 'local_modified' ? copy.row.viewDiff : copy.row.viewUpdate}
            onClick={props.onPreviewUpdate}
            isDisabled={props.busy}
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
        <MetadataListItem label={copy.detail.contextLabel}>
          <Text type="body">
            {copy.context.decision[contextStatus]}
            {skill.pinned ? ` · ${copy.detail.pinned}` : ''}
          </Text>
        </MetadataListItem>
        <MetadataListItem label={copy.detail.runtimeLabel}>
          <Text type="body">{formatSkillRuntimeLabel(skill, copy)}</Text>
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

      {props.onDelete && skill.manageable !== false ? (
        <>
          <Divider />
          <Button
            size="sm"
            variant="ghost"
            label={copy.row.delete}
            onClick={props.onDelete}
            isDisabled={props.busy}
            style={{ color: 'var(--destructive-text)' }}
          />
        </>
      ) : null}
    </VStack>
  );
}
