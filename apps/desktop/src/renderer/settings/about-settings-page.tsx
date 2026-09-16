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

import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { Link, Text, VStack } from '@astryxdesign/core';
import {
  Banner,
  Button,
  MakaWordmark,
  useMountedRef,
  useToast,
  useUiLocale,
  type ToastApi,
} from '@maka/ui';
import {
  AppUpdateAboutProjectionConsumer,
  type AppUpdateAboutProjection,
} from '../features/app-update/index.js';
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
 * The page is an identity lead over rows of one shape — label, one quiet line,
 * one control at the end — the Astryx settings idiom (the CLI's
 * settings-sidebar template).
 *
 * Two control faces, and that split is Astryx's own rule, not ours: `Button`
 * "is for actions like saving, deleting, or submitting"; `Link` is for
 * "navigating between pages or to external URLs" and its docs say not to use
 * it "for actions that do not navigate". So 检查更新, 重启安装, 复制 and 查看
 * are buttons, and the places that leave the app are links. The row-end link
 * takes the button's inline inset so both faces end on one text edge.
 */

/* The ghost `sm` button pads its label by one spacing step; without the same
   inset the link's text sits 12px further right than the buttons' text. */
const linkInRowEnd = { paddingInline: 'var(--spacing-3)' } as const;
type AboutCopy = ReturnType<typeof getSettingsPreferencesCopy>['about'];

/**
 * About's update row for a packaged install. A component rather than the
 * consumer's render callback because the action guard is a hook.
 */
function AboutUpdateStatusRow(props: {
  readonly update: AppUpdateAboutProjection;
  readonly copy: AboutCopy;
  readonly locale: ReturnType<typeof useUiLocale>;
  readonly toast: ToastApi;
  readonly mountedRef: RefObject<boolean>;
}) {
  const { update, copy, locale, toast, mountedRef } = props;
  const checkUpdateGuard = useActionGuard<'check'>();
  const row = aboutUpdateRow(update.status, copy, {
    errorDetail: (message) => settingsActionErrorMessage(message, locale),
  });

  async function checkForUpdates() {
    if (!checkUpdateGuard.begin('check')) return;
    try {
      const status = await update.checkForUpdates();
      if (status.state === 'error') {
        toast.error(
          copy.updateFailed[status.operation],
          settingsActionErrorMessage(status.message, locale),
        );
      }
    } catch (error) {
      if (mountedRef.current) {
        toast.error(copy.updateFailed.check, settingsActionErrorMessage(error, locale));
      }
    } finally {
      checkUpdateGuard.finish();
    }
  }

  /* One button in every state, so the row never changes shape: the updater's
     own work only disables it, and a downloaded update swaps its label. */
  const end = row.action === 'install' ? (
    <Button
      variant="primary"
      size="sm"
      isLoading={update.installPending}
      onClick={() => update.installDownloadedUpdate?.()}
      label={copy.installUpdate}
    />
  ) : (
    <Button
      variant="secondary"
      size="sm"
      isDisabled={row.action === 'busy'}
      isLoading={update.checking || row.action === 'checking'}
      onClick={() => void checkForUpdates()}
      label={copy.checkForUpdates}
    />
  );

  return <SettingsRow label={row.label} description={row.description} end={end} />;
}

export function AboutSettingsPage(props: { onOpenKeyboardHelp?(): void }) {
  const locale = useUiLocale();
  const copy = getSettingsPreferencesCopy(locale).about;
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [copyingDiagnostics, setCopyingDiagnostics] = useState(false);
  const diagnosticCopyGuard = useActionGuard<'copy'>();
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

  let identity: ReactNode;
  if (!info && !infoError) {
    identity = (
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
    identity = <Banner status="info" role="alert" title={copy.unavailable} description={infoError} />;
  } else {
    /* The wordmark names the product, so the version stands alone; as text,
       not a Heading, so it does not rank beside the 更新 and 支持 group titles. */
    identity = (
      <VStack gap={1}>
        <Text weight="semibold">{`v${info.appVersion}`}</Text>
        <Text type="supporting" color="secondary">{aboutChannelSummary(info, copy)}</Text>
      </VStack>
    );
  }

  return (
    <SettingsPage>
      {/* Unlabeled because the page title already says 关于. */}
      <SettingsSection variant="bare">
        <VStack gap={4}>
          <MakaWordmark width={128} title="Maka" />
          {identity}
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
        </VStack>
      </SettingsSection>
      {/* A dev checkout follows no feed, so it gets no update group at all: its
          channel line already says it does not update. */}
      {info && info.buildMode !== 'dev' ? (
        <SettingsSection title={copy.updateTitle}>
          <AppUpdateAboutProjectionConsumer>
            {(update) => (
              <AboutUpdateStatusRow
                update={update}
                copy={copy}
                locale={locale}
                toast={toast}
                mountedRef={aboutPageMountedRef}
              />
            )}
          </AppUpdateAboutProjectionConsumer>
        </SettingsSection>
      ) : null}
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
    </SettingsPage>
  );
}
