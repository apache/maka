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

import { useEffect, useState, type ReactNode } from 'react';
import { Link, Text } from '@astryxdesign/core';
import { Banner, Button, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import type { AppUpdateStatus } from '../../preload/bridge-contract.js';
import { SettingsPage, SettingsRow, SettingsSection } from './settings-section.js';
import { settingsActionErrorMessage } from './settings-error-copy.js';
import { SettingsSkeletonStack } from './settings-skeleton.js';
import { useActionGuard } from './use-action-guard.js';
import { aboutChannelSummary, aboutUpdateRow } from './about-update-status.js';
import { getSettingsPreferencesCopy } from '../locales/settings-preferences-copy.js';
import {
  defaultRuntimeHostDiagnosticTarget,
  runOnDefaultRuntimeHost,
} from '../default-runtime-host-operation.js';

type AppInfo = Awaited<ReturnType<typeof window.maka.app.info>>;

const REPOSITORY_URL = 'https://github.com/apache/maka';
const ISSUE_TRACKER_URL = `${REPOSITORY_URL}/issues`;
const RELEASES_URL = `${REPOSITORY_URL}/releases`;

/**
 * The page is rows of one shape — label, one quiet line, one control at the
 * end — because that is the Astryx settings idiom (the CLI's settings-sidebar
 * template), and because every second vocabulary on this page (a keycap, a
 * token, secondary buttons, a bulleted list) was a second thing to read on a
 * page whose content is four facts and three actions.
 *
 * Two control faces remain, and that split is Astryx's own rule, not ours:
 * `Button` "is for actions like saving, deleting, or submitting"; `Link` is
 * for "navigating between pages or to external URLs" and its docs say not to
 * use it "for actions that do not navigate". So 检查更新, 复制 and 查看 are
 * buttons (secondary or ghost "based on emphasis"), and the two places that
 * leave the app are links. The link takes the button's inline inset so both
 * faces end on one text edge.
 */

/* The ghost `sm` button pads its label by one spacing step; without the same
   inset the link's text sits 12px further right than the buttons' text. */
const linkInRowEnd = { paddingInline: 'var(--spacing-3)' } as const;
export function AboutSettingsPage(props: { onOpenKeyboardHelp?(): void }) {
  const locale = useUiLocale();
  const copy = getSettingsPreferencesCopy(locale).about;
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [copyingDiagnostics, setCopyingDiagnostics] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const diagnosticCopyGuard = useActionGuard<'copy'>();
  const checkUpdateGuard = useActionGuard<'check'>();
  const aboutPageMountedRef = useMountedRef();
  const toast = useToast();

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
        if (!cancelled) {
          const message = settingsActionErrorMessage(error, locale);
          setInfoError(message);
          toast.error(
            copy.loadFailed,
            message,
            undefined,
            defaultRuntimeHostDiagnosticTarget(error),
          );
        }
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
        toast.error(
          copy.updateFailed[status.operation],
          settingsActionErrorMessage(status.message, locale),
        );
      }
    } catch (error) {
      if (aboutPageMountedRef.current) {
        toast.error(copy.updateFailed.check, settingsActionErrorMessage(error, locale));
      }
    } finally {
      checkUpdateGuard.finish();
      if (aboutPageMountedRef.current) setCheckingUpdate(false);
    }
  }

  let identity: ReactNode;
  if (!info && !infoError) {
    identity = (
      <SettingsSection variant="bare">
        <SettingsSkeletonStack
          label={copy.loading}
          lines={[
            { width: '38%', size: 'lg' },
            { width: '70%' },
            { width: '52%' },
          ]}
        />
      </SettingsSection>
    );
  } else if (!info) {
    identity = (
      <SettingsSection variant="bare">
        <Banner status="info" role="alert" title={copy.unavailable} description={infoError} />
      </SettingsSection>
    );
  } else {
    const update = aboutUpdateRow(updateStatus, copy, {
      errorDetail: (message) => settingsActionErrorMessage(message, locale),
    });
    identity = (
      /* The two facts a user opens this page for, as the unlabeled lead group:
         which build this is, and whether it is current. Unlabeled because the
         page title already says 关于.

         A dev checkout follows no feed, so it gets no update row at all: its
         channel line already says it does not update. Everywhere else the row
         offers 检查更新 only where the service would honour one; a downloaded
         update says where the restart is (the sidebar footer owns that
         handshake) rather than growing a second one here. */
      <SettingsSection>
        <SettingsRow label={`Maka v${info.appVersion}`} description={aboutChannelSummary(info, copy)} />
        {info.buildMode === 'dev' ? null : (
          <SettingsRow
            label={update.label}
            description={update.description ?? undefined}
            end={update.action === 'none' ? undefined : (
              /* Secondary, not primary: the page has no task to complete, and
                 the one action the update flow cannot do without (the restart)
                 lives in the sidebar reminder. Not ghost either: unlike 复制
                 and 查看 below, this changes the updater's state. */
              <Button
                variant="secondary"
                size="sm"
                isLoading={checkingUpdate || update.action === 'checking'}
                onClick={() => void checkForUpdates()}
                label={copy.checkForUpdates}
              />
            )}
          />
        )}
      </SettingsSection>
    );
  }

  return (
    <SettingsPage>
      {identity}
      {/* Support lives OUTSIDE the info conditional on purpose: copying
          diagnostics must not depend on `app.info` succeeding — that is the
          very moment a user needs it. The keyboard sheet used to be reachable
          only from the titlebar's `…` drawer and two shortcuts, which made
          the panel listing the shortcuts openable only by shortcut; this is
          the entry a mouse can find.

          The verb on the face ("复制") is not a name; the row's label is.
          `Item` puts the row label in a sibling element, so each control
          carries its own aria-label instead of borrowing one. */}
      <SettingsSection title={copy.supportTitle}>
        <SettingsRow
          label={copy.copyDiagnostics}
          description={copy.copyHelp}
          end={(
            <Button
              variant="ghost"
              size="sm"
              isLoading={copyingDiagnostics}
              onClick={() => void copyDiagnostics()}
              aria-label={copy.copyDiagnostics}
              label={copy.copyAction}
            />
          )}
        />
        <SettingsRow
          label={copy.reportIssueLabel}
          description={copy.reportIssueHelp}
          end={(
            <Link
              href={ISSUE_TRACKER_URL}
              target="_blank"
              rel="noreferrer noopener"
              label={copy.reportIssueLabel}
              style={linkInRowEnd}
            >
              {copy.reportIssueOpen}
            </Link>
          )}
        />
        {props.onOpenKeyboardHelp ? (
          <SettingsRow
            label={copy.keyboardShortcuts}
            description={copy.keyboardShortcutsHelp}
            end={(
              <Button
                variant="ghost"
                size="sm"
                onClick={props.onOpenKeyboardHelp}
                aria-label={copy.keyboardShortcuts}
                label={copy.keyboardShortcutsOpen}
              />
            )}
          />
        ) : null}
      </SettingsSection>
      {/* Provenance is one quiet line, not a group: nothing here is a setting
          or an action the user came for. */}
      <SettingsSection variant="bare">
        <Text type="supporting" color="secondary">
          {copy.openSourceSummary}
          {' · '}
          <Link href={REPOSITORY_URL} target="_blank" rel="noreferrer noopener" type="inherit">
            {copy.sourceCode}
          </Link>
          {' · '}
          <Link href={RELEASES_URL} target="_blank" rel="noreferrer noopener" type="inherit">
            {copy.releaseNotes}
          </Link>
        </Text>
      </SettingsSection>
    </SettingsPage>
  );
}
