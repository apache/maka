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

// packages/ui/src/skill-status.ts
//
// One severity reading for one Skill, shared by the list rows and the
// inspector so a skill never reads as two different states depending on
// where it is shown — the same contract scheduled-task-status.ts keeps for
// 定时任务.
//
// Meaning rules: `error` is a broken state file or unreadable metadata;
// `attention` is anything that asks for a decision (review, shadowed,
// budget-omitted, a managed update); a deliberately disabled skill is
// `neutral`, not broken; an enabled skill in context is simply `active`,
// never success-green. What those words look like is status-vocabulary's
// call, not this file's.

import { dotForStatus, type StatusSemantic } from './status-vocabulary.js';
import type { SkillEntry } from './module-panel-types.js';
import type { SkillsCopy } from './skills-copy.js';

export function skillContextStatus(skill: SkillEntry): NonNullable<SkillEntry['contextStatus']> {
  return skill.contextStatus ?? (skill.enabled ? 'advertised' : 'disabled');
}

function hasManagedUpdateAttention(skill: SkillEntry): boolean {
  return skill.sourceType === 'managed'
    && skill.managedUpdateStatus !== undefined
    && skill.managedUpdateStatus !== 'not_managed'
    && skill.managedUpdateStatus !== 'up_to_date';
}

/**
 * The ladder is the domain knowledge here: which of a skill's several
 * independent problems wins the one dot it gets. Broken beats needs-looking-at
 * beats off beats fine, and the order inside each rung is this file's business
 * — status-vocabulary only decides what the words look like.
 */
export function skillStatusSemantic(skill: SkillEntry): StatusSemantic {
  const contextStatus = skillContextStatus(skill);
  if (skill.runtimeStatus === 'state_error' || skill.validationStatus === 'metadata_error' || contextStatus === 'invalid') {
    return 'error';
  }
  if (skill.kind === 'discovery_diagnostic') return 'attention';
  if (skill.needsReview) return 'attention';
  if (skill.validationStatus && skill.validationStatus !== 'ok') return 'attention';
  if (contextStatus === 'shadowed' || contextStatus === 'budget' || contextStatus === 'host_incompatible') {
    return 'attention';
  }
  if (hasManagedUpdateAttention(skill)) return 'attention';
  if (!skill.enabled) return 'neutral';
  return 'active';
}

export function skillStatusDotVariant(skill: SkillEntry) {
  return dotForStatus(skillStatusSemantic(skill));
}

/**
 * Exceptional state leads the row as TEXT, never only as the dot's colour
 * (WCAG 1.4.1; the dot sits outside the row's button). A plain enabled skill
 * stays silent — naming the normal case on every row is the noise this list
 * is built to avoid.
 */
export function skillExceptionalStateLabel(skill: SkillEntry, copy: SkillsCopy): string | null {
  // The diagnostic row is itself the message; it does not lead with a label.
  if (skill.kind === 'discovery_diagnostic') return null;
  if (skill.runtimeStatus === 'state_error') return copy.status.stateError;
  if (skill.validationStatus === 'metadata_error') return copy.status.metadataError;
  const contextStatus = skillContextStatus(skill);
  if (contextStatus !== 'advertised' && contextStatus !== 'disabled') {
    return copy.context.decision[contextStatus];
  }
  if (skill.needsReview) return copy.context.needsReview;
  if (hasManagedUpdateAttention(skill)) {
    return copy.status.managed[skill.managedUpdateStatus ?? 'up_to_date'];
  }
  return null;
}

/** The dot's accessible name: the exceptional state, or the plain runtime. */
export function skillStatusDotLabel(skill: SkillEntry, copy: SkillsCopy): string {
  return skillExceptionalStateLabel(skill, copy) ?? formatSkillRuntimeLabel(skill, copy);
}

export function formatSkillStatusLabel(skill: SkillEntry, copy: SkillsCopy): string {
  if (skill.validationStatus === 'metadata_error') return copy.status.metadataError;
  if (skill.sourceType === 'managed') {
    return copy.status.managed[skill.managedUpdateStatus ?? 'up_to_date'];
  }
  if (skill.userModified) return copy.status.modified;
  if (skill.sourceType === 'bundled') return copy.status.bundled;
  return copy.status.local;
}

export function formatSkillRuntimeLabel(skill: SkillEntry, copy: SkillsCopy): string {
  if (skill.runtimeStatus === 'state_error') return copy.status.stateError;
  return skill.enabled ? copy.status.enabled : copy.status.disabled;
}

export function formatSkillLibraryDescription(skill: SkillEntry, copy: SkillsCopy): string | undefined {
  const raw = skill.description?.trim();
  if (!raw) return undefined;
  if (/[\u3400-\u9fff]/.test(raw)) return raw;

  const source = `${skill.id} ${skill.name} ${raw}`.toLowerCase();
  if (source.includes('docx') || source.includes('word') || source.includes('google docs')) {
    return copy.description.document;
  }
  if (source.includes('ppt') || source.includes('powerpoint') || source.includes('slide') || source.includes('presentation')) {
    return copy.description.presentation;
  }
  if (source.includes('spreadsheet') || source.includes('excel') || source.includes('csv') || source.includes('xlsx')) {
    return copy.description.spreadsheet;
  }
  if (source.includes('image') || source.includes('photo') || source.includes('bitmap')) {
    return copy.description.image;
  }
  if (source.includes('browser') || source.includes('chrome') || source.includes('web target')) {
    return copy.description.browser;
  }
  if (source.includes('macos') || source.includes('swiftui') || source.includes('appkit')) {
    return copy.description.macos;
  }
  return copy.description.fallback;
}
