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

import { useEffect, useState } from 'react';
import type { UpdateAppSettingsResult } from '@maka/core/settings';
import { Button, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { FolderOpen, ICON_SIZE, X } from '@maka/ui/icons';
import type { DesktopRuntimeHostRef } from '../../preload/bridge-contract.js';
import { getSettingsPreferencesCopy } from '../locales/settings-preferences-copy.js';
import { settingsActionErrorMessage } from './settings-error-copy.js';
import { SettingsActions, SettingsRow } from './settings-section.js';
import { useKeyedActionGuard } from './use-action-guard.js';

/**
 * Whether the selected Runtime Host can own a local default at all.
 *
 * The Projects page already reads `setLocalDefault` off the project snapshot to
 * decide whether its default-project control means anything on this target; the
 * default working directory has exactly the same boundary, so it reuses that
 * capability rather than adding a target-specific settings path. Remote targets
 * report `false` and never receive `defaultWorkingDirectory` in their
 * ProjectRootController, so the control stays hidden there.
 */
export function useLocalDefaultCapability(
  host: DesktopRuntimeHostRef | undefined,
  targetVerified: boolean,
): boolean {
  const mountedRef = useMountedRef();
  const [canSetLocalDefault, setCanSetLocalDefault] = useState(false);
  useEffect(() => {
    if (!host || !targetVerified) {
      setCanSetLocalDefault(false);
      return;
    }
    let cancelled = false;
    void window.maka.projects.getSnapshot(undefined, host).then(
      (snapshot) => {
        if (!cancelled && mountedRef.current) {
          setCanSetLocalDefault(snapshot.capabilities.setLocalDefault);
        }
      },
      // A failed capability read is not a reason to offer a control whose
      // target may ignore it; stay hidden rather than guess.
      () => {
        if (!cancelled && mountedRef.current) setCanSetLocalDefault(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [host, mountedRef, targetVerified]);
  return canSetLocalDefault;
}

/**
 * Settings · 常规 · 默认工作目录 — the folder new tasks and Bot conversations
 * open in when they have no Project.
 *
 * The row only reports and edits the preference; which directory a session
 * actually gets is decided in one place in the main process
 * (`resolveUnassociatedRoot`: selected Project → configured default →
 * fallback roots). Nothing here re-derives a path.
 *
 * The value lives in the client-owned `projects` section, so it is per-machine
 * and saved through the client settings tier, not shared with every other
 * client of a Runtime Host — a working directory only exists on one filesystem.
 */
export function DefaultWorkingDirectoryRow(props: {
  defaultWorkingDirectory?: string;
  onUpdate(
    patch: Parameters<typeof window.maka.settings.update>[0],
  ): Promise<UpdateAppSettingsResult>;
}) {
  const locale = useUiLocale();
  const copy = getSettingsPreferencesCopy(locale).general;
  const toast = useToast();
  const mountedRef = useMountedRef();
  // Same re-entrancy reasoning as the other rows in this card: a disabled
  // trigger cannot fully prevent overlapping saves, and overlapping
  // settings.update calls have no ordering guarantee.
  const persistGuard = useKeyedActionGuard<'working-directory'>();
  const [saving, setSaving] = useState(false);

  async function updateWorkingDirectory(action: 'choose' | 'clear') {
    const releaseSave = persistGuard.begin('working-directory');
    if (!releaseSave) return;
    setSaving(true);
    try {
      const defaultWorkingDirectory =
        action === 'choose'
          ? await window.maka.settings.chooseDefaultWorkingDirectory()
          : undefined;
      // A cancelled picker is not a request to clear the preference.
      if (action === 'choose' && defaultWorkingDirectory === undefined) return;
      await props.onUpdate({ projects: { defaultWorkingDirectory } });
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          copy.saveDefaultWorkingDirectoryFailed,
          settingsActionErrorMessage(error, locale),
        );
      }
    } finally {
      releaseSave();
      if (mountedRef.current) setSaving(false);
    }
  }

  return (
    <>
      <SettingsRow
        label={copy.defaultWorkingDirectory}
        description={
          <>
            {copy.defaultWorkingDirectoryHelp}
            <code className="settingsWorkingDirectoryPath">
              {props.defaultWorkingDirectory ?? copy.notSet}
            </code>
          </>
        }
      />
      <SettingsActions role="group" aria-label={copy.defaultWorkingDirectory}>
        <Button
          variant="secondary"
          size="sm"
          icon={<FolderOpen size={ICON_SIZE.chrome} aria-hidden="true" />}
          label={copy.chooseDefaultWorkingDirectory}
          isDisabled={saving}
          onClick={() => void updateWorkingDirectory('choose')}
        />
        {props.defaultWorkingDirectory ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<X size={ICON_SIZE.chrome} aria-hidden="true" />}
            label={copy.clearDefaultWorkingDirectory}
            isDisabled={saving}
            onClick={() => void updateWorkingDirectory('clear')}
          />
        ) : null}
      </SettingsActions>
    </>
  );
}
