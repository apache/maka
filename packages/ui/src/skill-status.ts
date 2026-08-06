// packages/ui/src/skill-status.ts
//
// One severity reading for one Skill, shared by the list rows and the
// inspector so a skill never reads as two different states depending on
// where it is shown — the same contract plan-reminder-status.ts keeps for
// 定时任务.
//
// Tone rules: error is a broken state file or unreadable metadata; warning
// is anything that asks for a decision (review, shadowed, budget-omitted, a
// managed update); a deliberately disabled skill is neutral, not broken; an
// enabled skill in context is simply live (accent), never success-green.

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

export function skillStatusDotVariant(skill: SkillEntry): 'accent' | 'warning' | 'error' | 'neutral' {
  const contextStatus = skillContextStatus(skill);
  if (skill.runtimeStatus === 'state_error' || skill.validationStatus === 'metadata_error' || contextStatus === 'invalid') {
    return 'error';
  }
  if (skill.kind === 'discovery_diagnostic') return 'warning';
  if (skill.needsReview) return 'warning';
  if (skill.validationStatus && skill.validationStatus !== 'ok') return 'warning';
  if (contextStatus === 'shadowed' || contextStatus === 'budget' || contextStatus === 'host_incompatible') {
    return 'warning';
  }
  if (hasManagedUpdateAttention(skill)) return 'warning';
  if (!skill.enabled) return 'neutral';
  return 'accent';
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
