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

// The 身份 group of the 通用 page: how Maka addresses you, the interface
// language, and the assistant tone.
//
// It used to live in appearance-settings-page.tsx as
// `PersonalizationSettingsPage`, left behind when the designer audit (P2-13)
// moved identity off 外观 and onto 通用 — so the only consumer,
// general-settings-page.tsx, imported a *page* out of the *appearance* file
// and rendered it inside its own `SettingsPage`, nesting one page stack in
// another. It is one section of someone else's page: named, filed, and shaped
// as one.
import { useEffect, useRef, useState } from 'react';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core';
import { SettingsField, SettingsRow, SettingsSection } from './settings-section';
import { SettingsExpandableRow } from './settings-expandable-row';
import { getSettingsSharedCopy } from '../locales/settings-shared-copy';
import type { AppSettings, PersonalizationSettings, UpdateAppSettingsResult } from '@maka/core/settings';
import type { UiLocalePreference } from '@maka/core/ui-locale';
import { TextArea, TextInput, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { settingsActionErrorMessage } from './settings-error-copy';
import { getSettingsPreferencesCopy } from '../locales/settings-preferences-copy.js';
import { useOptionalRuntimeHostSettingsTarget } from './runtime-host-settings-target.js';

// PR-TONE-AUTOSAVE-0: the personalization block used to be the page's ONLY
// control with an explicit 保存 button + helper line — every neighboring row
// (显示名称 / 界面语言 / 默认模型 / switches) persists silently on change or
// blur. Two save models on one page. This block now autosaves like its
// siblings: 显示名称 and 助手语气偏好 flush on blur (and the tone textarea
// also debounces mid-typing), 界面语言 persists on change. No button, no
// success toast — silence is the page's success language; only failures
// surface (toast.error, like every sibling persist path).

export function PersonalizationSettingsSection(props: {
  settings: AppSettings;
  runtimeHostAvailable: boolean;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
}) {
  const host = useOptionalRuntimeHostSettingsTarget();
  const locale = useUiLocale();
  const copy = getSettingsPreferencesCopy(locale).personalization;
  const sections = getSettingsPreferencesCopy(locale).sections;
  const sharedCopy = getSettingsSharedCopy(locale);
  // At most one row in the group is open — the template's own rule.
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  // Persist the tone textarea this long after the user stops typing; blur
  // flushes immediately regardless.
  const TONE_AUTOSAVE_DEBOUNCE_MS = 800;
  const value = props.settings.personalization;
  const [displayName, setDisplayName] = useState(value.displayName);
  const [assistantTone, setAssistantTone] = useState(value.assistantTone);
  const [uiLocale, setUiLocale] = useState<UiLocalePreference>(value.uiLocale);
  const toast = useToast();
  const personalizationMountedRef = useMountedRef();
  // The shared ticket limits stale failure feedback. Locale reconciliation
  // has separate ownership because a later display-name or tone save must not
  // suppress rollback of a failed language preference.
  const persistTicketRef = useRef(0);
  const localePersistTicketRef = useRef(0);
  const persistPendingCountRef = useRef(0);
  // Debounce timer for the tone textarea; flushed immediately on blur.
  const toneDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      // Invalidate any in-flight save's late UI write, and drop the pending
      // debounced flush so it can't fire after the panel closes.
      persistTicketRef.current += 1;
      localePersistTicketRef.current += 1;
      if (toneDebounceRef.current) {
        clearTimeout(toneDebounceRef.current);
        toneDebounceRef.current = null;
      }
    };
  }, []);

  // PR-PERSONALIZATION-SYNC-0: sync form state when the persisted
  // personalization changes externally. Two real scenarios:
  //   1. Server-side sanitization (control chars, secret-shaped
  //      patterns) rewrites the input on save — local state would
  //      otherwise keep showing the raw typed value while the
  //      persisted store has the sanitized version.
  //   2. Another agent / background sync mutates settings while the
  //      panel is open.
  // Guarded on the pending-save count so an autosave that's still in
  // flight doesn't get its optimistic local value reset out from under
  // the user mid-edit — the sync only lands when nothing is in flight.
  useEffect(() => {
    if (persistPendingCountRef.current > 0) return;
    setDisplayName(value.displayName);
    setAssistantTone(value.assistantTone);
    setUiLocale(value.uiLocale);
  }, [value.displayName, value.assistantTone, value.uiLocale]);

  // Shared persist path for every personalization field. Locale has its own
  // last-write-wins lane so unrelated saves cannot steal rollback ownership.
  // Returns whether the write landed. The autosaving fields ignore it — they
  // have nowhere to put the answer — but a row that closes on save has to
  // know, or a failed write collapses the row onto the old value and drops
  // the draft with only a toast to show for it.
  async function persistPersonalization(patch: Partial<PersonalizationSettings>): Promise<boolean> {
    const ticket = ++persistTicketRef.current;
    const localeTicket = patch.uiLocale === undefined ? null : ++localePersistTicketRef.current;
    persistPendingCountRef.current += 1;
    try {
      const result = await props.onUpdate({ personalization: patch });
      // Saved. An unmounted page just has nowhere left to reflect it.
      if (!personalizationMountedRef.current) return true;
      if (localeTicket !== null && localeTicket === localePersistTicketRef.current) {
        setUiLocale(result.settings.personalization.uiLocale);
      }
      return true;
    } catch (error) {
      if (!personalizationMountedRef.current) return false;
      if (localeTicket !== null && localeTicket === localePersistTicketRef.current) {
        setUiLocale(value.uiLocale);
      }
      if (ticket === persistTicketRef.current) {
        const targetsRuntimeHost =
          patch.displayName !== undefined || patch.assistantTone !== undefined;
        toast.error(
          copy.saveFailed,
          settingsActionErrorMessage(error, locale),
          undefined,
          targetsRuntimeHost && host ? { profileId: host.profileId } : undefined,
        );
      }
      return false;
    } finally {
      persistPendingCountRef.current = Math.max(0, persistPendingCountRef.current - 1);
    }
  }

  function persistLocale(next: UiLocalePreference) {
    setUiLocale(next);
    void persistPersonalization({ uiLocale: next });
  }

  // Tone autosave: debounce mid-typing so we don't hammer settings.update on
  // every keystroke, then flush the pending value immediately on blur (blur
  // wins — clears the timer and saves right away).
  function scheduleToneSave(nextValue: string) {
    if (toneDebounceRef.current) clearTimeout(toneDebounceRef.current);
    toneDebounceRef.current = setTimeout(() => {
      toneDebounceRef.current = null;
      void persistPersonalization({ assistantTone: nextValue.trim().slice(0, 500) });
    }, TONE_AUTOSAVE_DEBOUNCE_MS);
  }

  function flushTone(nextValue: string) {
    if (toneDebounceRef.current) {
      clearTimeout(toneDebounceRef.current);
      toneDebounceRef.current = null;
    }
    void persistPersonalization({ assistantTone: nextValue.trim().slice(0, 500) });
  }

  return (
    /* These editable values stay in the same grouped Settings card as the
       neighboring preferences; the full-width tone field uses the vertical
       row variant. The 通用 page owns the `SettingsPage` stack this sits in. */
    <SettingsSection title={sections.identity} description={sections.identityHelp}>
      {/* A name you set once and then read. A permanently-open input asked
          the user to fill in something already filled in, and its blur-save
          gave them no way to back out of a change. The row reports the
          settled value and opens on demand; Cancel puts the draft back. */}
      {props.runtimeHostAvailable ? (
        <SettingsExpandableRow
          label={copy.displayName}
          value={value.displayName || copy.displayNameUnset}
          actionLabel={value.displayName ? copy.displayNameChange : copy.displayNameSet}
          isEditing={expandedRow === 'displayName'}
          canSave={displayName.trim() !== value.displayName}
          saveLabel={sharedCopy.save}
          cancelLabel={sharedCopy.cancel}
          onEdit={() => {
            setDisplayName(value.displayName);
            setExpandedRow('displayName');
          }}
          onCancel={() => {
            setDisplayName(value.displayName);
            setExpandedRow(null);
          }}
          onSave={async () => {
            if (await persistPersonalization({ displayName: displayName.trim().slice(0, 60) })) {
              setExpandedRow(null);
            }
          }}
        >
          <TextInput
            type="text"
            value={displayName}
            onChange={(value) => setDisplayName(value.slice(0, 60))}
            placeholder={copy.displayNamePlaceholder}
            label={copy.displayName}
            description={copy.displayNameHelp}
            isLabelHidden
            width="100%"
          />
        </SettingsExpandableRow>
      ) : null}
      {/*
        PR-LANG-PREF-0 (WAWQAQ msg `edc9cb41` + kenji `7e532892`
        acceptance criteria): 自动 / 中文 / English. User explicit
        choice wins over the temporary auto -> zh fallback;
        e2e-fixture override wins over both (deterministic baselines).
      */}
      <SettingsRow
        label={copy.interfaceLanguage}
        description={copy.interfaceLanguageHelp}
        end={<SegmentedControl
          value={uiLocale}
          onChange={(next) => persistLocale(next as UiLocalePreference)}
          label={copy.interfaceLanguage}
        >
          {copy.localeOptions.map(([value, label]) => (
            <SegmentedControlItem key={value} value={value} label={label} />
          ))}
        </SegmentedControl>}
      />
      {props.runtimeHostAvailable ? <SettingsField>
        {/* No fixed height style: it lands as inline style on the wrapper,
            which pins the visible box while the inner textarea keeps its
            native `resize: vertical` — dragging then moves only the grip.
            `rows` owns the default height; the wrapper follows the
            textarea, so user resizing works. */}
        <TextArea
          value={assistantTone}
          onChange={(value) => {
            const next = value.slice(0, 500);
            setAssistantTone(next);
            scheduleToneSave(next);
          }}
          onBlur={() => flushTone(assistantTone)}
          placeholder={copy.assistantTonePlaceholder}
          rows={4}
          hasSpellCheck={false}
          label={copy.assistantTone}
          description={copy.assistantToneHelp}
          width="100%"
        />
      </SettingsField> : null}
    </SettingsSection>
  );
}
