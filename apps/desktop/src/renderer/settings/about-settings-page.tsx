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

import { useEffect, useId, useState, type ReactNode } from 'react';
import { Badge, Link, List, ListItem } from '@astryxdesign/core';
import { Kbd } from '@astryxdesign/core/Kbd';
import { Sparkles } from '@maka/ui/icons';
import {
  Banner,
  Button,
  PageHeader,
  useMountedRef,
  useToast,
  useUiLocale,
} from '@maka/ui';
import type { AppUpdateStatus } from '../../preload/bridge-contract.js';
import { SettingsActions, SettingsPage, SettingsSection } from './settings-section.js';
import { SettingRow } from './settings-rows.js';
import { settingsActionErrorMessage } from './settings-error-copy.js';
import { SettingsSkeletonStack } from './settings-skeleton.js';
import { useActionGuard } from './use-action-guard.js';
import { aboutUpdateStatusDetail } from './about-update-status.js';
import { getSettingsPreferencesCopy } from '../locales/settings-preferences-copy.js';
import { getSettingsSharedCopy } from '../locales/settings-shared-copy.js';
import {
  defaultRuntimeHostDiagnosticTarget,
  runOnDefaultRuntimeHost,
} from '../default-runtime-host-operation.js';

type AppInfo = Awaited<ReturnType<typeof window.maka.app.info>>;

const ISSUE_TRACKER_URL = 'https://github.com/apache/maka/issues';

export function AboutSettingsPage(props: { onOpenKeyboardHelp?(): void }) {
  const locale = useUiLocale();
  const copy = getSettingsPreferencesCopy(locale).about;
  const sharedCopy = getSettingsSharedCopy(locale);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [copyingDiagnostics, setCopyingDiagnostics] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const diagnosticCopyGuard = useActionGuard<'copy'>();
  const checkUpdateGuard = useActionGuard<'check'>();
  const aboutPageMountedRef = useMountedRef();
  const toast = useToast();
  const diagnosticsHelpId = useId();
  const updateHelpId = useId();

  useEffect(() => {
    let cancelled = false;
    runOnDefaultRuntimeHost((host) => window.maka.app.info(host))
      .then(({ value }) => {
        if (!cancelled) {
          setInfo(value);
          setInfoError(null);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        const message = settingsActionErrorMessage(error, locale);
        setInfoError(message);
        toast.error(
          copy.loadFailed,
          message,
          undefined,
          defaultRuntimeHostDiagnosticTarget(error),
        );
    });
    return () => {
      cancelled = true;
    };
  }, [copy.loadFailed, locale, toast]);

  useEffect(() => {
    let cancelled = false;
    window.maka.app
      .updateStatus()
      .then((status) => {
        if (!cancelled) setUpdateStatus(status);
      })
      .catch(() => undefined);
    const unsubscribe = window.maka.app.subscribeUpdateStatus((status) => {
      if (!cancelled) setUpdateStatus(status);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  async function copyDiagnostics() {
    if (!diagnosticCopyGuard.begin('copy')) return;
    setCopyingDiagnostics(true);
    try {
      await window.maka.diagnostics.copyReport({ surface: 'manual' });
      if (aboutPageMountedRef.current) toast.success(copy.copied, copy.pasteHint);
    } catch {
      if (aboutPageMountedRef.current) {
        toast.error(copy.copyFailed, copy.clipboardUnavailable);
      }
    } finally {
      diagnosticCopyGuard.finish();
      if (aboutPageMountedRef.current) setCopyingDiagnostics(false);
    }
  }

  async function checkForUpdates() {
    if (!checkUpdateGuard.begin('check')) return;
    setCheckingUpdate(true);
    try {
      const status = await window.maka.app.checkForUpdates();
      if (aboutPageMountedRef.current) setUpdateStatus(status);
      if (status.state === 'error') {
        toast.error(copy.updateCheckFailed, copy.updateCheckFailedDetail(status.message));
      }
    } catch (error) {
      if (aboutPageMountedRef.current) {
        toast.error(copy.updateCheckFailed, settingsActionErrorMessage(error, locale));
      }
    } finally {
      checkUpdateGuard.finish();
      if (aboutPageMountedRef.current) setCheckingUpdate(false);
    }
  }

  let aboutContent: ReactNode;
  if (!info && !infoError) {
    aboutContent = (
      <SettingsSkeletonStack
        label={copy.loading}
        lines={[
          { width: '38%', size: 'lg' },
          { width: '70%' },
          { width: '52%' },
        ]}
      />
    );
  } else if (!info) {
    aboutContent = (
      <Banner
        status="info"
        role="alert"
        title={copy.unavailable}
        description={infoError} />
    );
  } else {
    aboutContent = (
      <>
        <PageHeader
          as_wrapper="div"
          className="settingsAboutHero"
          as="h2"
          icon={<Sparkles size={30} /> /* 64% of the 48px plate, matching .providerLogo's fill */}
          iconClassName="settingsAboutLogo"
          headingRowClassName="settingsAboutHeading"
          title="Maka"
          badge={
            <>
              <Badge variant="neutral" label={`v${info.appVersion}`} />
              <Badge
                variant="blue"
                label={info.buildMode === 'dev'
                  ? info.buildCommit
                    ? `${copy.devBuild} · ${info.buildCommit}`
                    : copy.devBuild
                  : copy.packagedBuild}
              />
            </>
          }
          subtitle={copy.subtitle}
          subtitleClassName="settingsAboutTagline"
        />
        {/* Detail audit: the five privacy commitments rendered inside an info
            Banner — five lines of bold status-blue body copy, the exact blue
            flood DESIGN.md's Signal-Not-Texture rule forbids. They are ordinary
            statements, so they read as a quiet marker list in a labeled group. */}
        <SettingsSection variant="bare" title={copy.privacyTitle}>
          <List aria-label={copy.privacyLabel} density="compact" listStyle="disc">
            {/* Fragment-wrapped: ListItem single-line-truncates STRING labels,
                and a privacy commitment must wrap, not ellipsize. */}
            {copy.privacyPoints.map((point) => <ListItem key={point} label={<>{point}</>} />)}
          </List>
        </SettingsSection>
        {/* The keyboard sheet's home. It used to be reachable only from the
            titlebar's `…` drawer and from two shortcuts — which made the panel
            that lists the shortcuts openable only by shortcut. It is reference
            material about the app, so it belongs on 关于, and this is the entry
            a mouse can find. */}
        {props.onOpenKeyboardHelp && (
          <SettingsSection title={sharedCopy.groups.reference}>
            <SettingRow
              title={copy.keyboardShortcuts}
              detail={copy.keyboardShortcutsHelp}
              action={(
                <Button variant="ghost" size="sm" onClick={props.onOpenKeyboardHelp} label={copy.keyboardShortcutsOpen} />
              )}
            />
          </SettingsSection>
        )}
        <SettingsSection title={copy.updatesTitle}>
          <SettingRow
            title={copy.checkForUpdates}
            detail={aboutUpdateStatusDetail(updateStatus, copy, {
              isDevBuild: info.buildMode === 'dev',
            })}
            action={(
              <Button
                variant="secondary"
                size="sm"
                isDisabled={checkingUpdate || info.buildMode === 'dev'}
                aria-describedby={updateHelpId}
                onClick={() => void checkForUpdates()}
                label={checkingUpdate || updateStatus?.state === 'checking'
                  ? copy.checkingForUpdates
                  : copy.checkForUpdates}
              />
            )}
          />
          <p id={updateHelpId}>
            {info.buildMode === 'dev' ? copy.updateDevBuildHelp : copy.updateHelp}
          </p>
        </SettingsSection>
      </>
    );
  }

  return (
    <SettingsPage>
      {aboutContent}
      <SettingsSection title={sharedCopy.groups.buildInfo}>
        <SettingsActions>
          <Button
            variant="primary"
            isDisabled={copyingDiagnostics}
            aria-describedby={diagnosticsHelpId}
            onClick={() => void copyDiagnostics()}
            label={copyingDiagnostics ? copy.copying : copy.copyDiagnostics}
          />
          <Kbd keys="mod+shift+d" />
          <Link href={ISSUE_TRACKER_URL} target="_blank" rel="noreferrer noopener">
            {copy.reportIssueLabel}
          </Link>
          <p id={diagnosticsHelpId}>{copy.copyHelp}</p>
        </SettingsActions>
      </SettingsSection>
    </SettingsPage>
  );
}
