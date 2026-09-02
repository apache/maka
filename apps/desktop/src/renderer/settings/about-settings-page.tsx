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
import {
  Heading,
  HStack,
  Link,
  List,
  ListItem,
  Text,
  Token,
  VStack,
} from '@astryxdesign/core';
import { Kbd } from '@astryxdesign/core/Kbd';
import { Banner, Button, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import type { AppUpdateStatus } from '../../preload/bridge-contract.js';
import { SettingsPage, SettingsRow, SettingsSection } from './settings-section.js';
import { settingsActionErrorMessage } from './settings-error-copy.js';
import { SettingsSkeletonStack } from './settings-skeleton.js';
import { useActionGuard } from './use-action-guard.js';
import { aboutChannelFacts, aboutUpdateStatusDetail } from './about-update-status.js';
import { getSettingsPreferencesCopy } from '../locales/settings-preferences-copy.js';
import {
  defaultRuntimeHostDiagnosticTarget,
  runOnDefaultRuntimeHost,
} from '../default-runtime-host-operation.js';

type AppInfo = Awaited<ReturnType<typeof window.maka.app.info>>;

const ISSUE_TRACKER_URL = 'https://github.com/apache/maka/issues';

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
    const channel = aboutChannelFacts(info, copy);
    const isDevBuild = info.buildMode === 'dev';
    identity = (
      /* The whole identity of this install, in one unlabeled lead group: what
         it is, which channel it follows, what that means, and whether it is up
         to date. Unlabeled because the page title already says 关于.

         There used to be a 版本信息 readout under this (channel / version /
         build / runtime / workspace) and a titled 软件更新 group around the
         status line. Both were restatements: the first three rows repeat these
         two lines verbatim, and runtime + workspace are already in the
         diagnostic report and on the 数据 page. */
      <SettingsSection variant="bare">
        <VStack gap={4}>
          <VStack gap={2}>
            <HStack gap={2} vAlign="center">
              <Heading level={2}>Maka</Heading>
              {/* Release installs carry no token: they are the default state,
                  and Astryx keeps colour for what departs from it. */}
              {channel.token ? (
                <Token size="sm" label={channel.token.label} color={channel.token.color} />
              ) : null}
            </HStack>
            <Text type="supporting" color="secondary">
              {info.buildCommit
                ? `v${info.appVersion} · ${copy.buildLabel} ${info.buildCommit}`
                : `v${info.appVersion}`}
            </Text>
            <Text type="body">{channel.summary}</Text>
          </VStack>
          {/* A dev checkout follows no feed, so it gets no status line at all:
              its channel sentence above already says it does not update, and
              the updater's own dev copy said the same thing a second time in
              the next paragraph. The row exists only where it can act.

              The status line says what the button would tell you, so it carries
              no label of its own. It wraps rather than crushes: at the 480px
              window floor the sentence needs the full width. */}
          {isDevBuild ? null : (
            <HStack gap={3} justify="between" wrap="wrap">
              <Text type="body">{aboutUpdateStatusDetail(updateStatus, copy)}</Text>
              <Button
                variant="secondary"
                size="sm"
                isDisabled={checkingUpdate}
                onClick={() => void checkForUpdates()}
                label={checkingUpdate || updateStatus?.state === 'checking'
                  ? copy.checkingForUpdates
                  : copy.checkForUpdates}
              />
            </HStack>
          )}
        </VStack>
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
          the entry a mouse can find. */}
      <SettingsSection title={copy.supportTitle}>
        <SettingsRow
          label={copy.copyDiagnostics}
          description={copy.copyHelp}
          end={(
            /* The verb on the face ("复制") is not a name; the row's label is.
               `Item` puts the row label in a sibling element, so each control
               carries its own aria-label instead of borrowing one. */
            <HStack gap={2} vAlign="center">
              <Button
                variant="ghost"
                size="sm"
                isDisabled={copyingDiagnostics}
                onClick={() => void copyDiagnostics()}
                aria-label={copy.copyDiagnostics}
                label={copyingDiagnostics ? copy.copying : copy.copyAction}
              />
              <Kbd keys="mod+shift+d" />
            </HStack>
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
              aria-label={copy.reportIssueLabel}
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
      {info ? (
        <SettingsSection title={copy.privacyTitle} variant="bare">
          <List aria-label={copy.privacyLabel} density="compact" listStyle="disc">
            {/* Fragment-wrapped: ListItem single-line-truncates STRING labels,
                and a privacy commitment must wrap, not ellipsize. */}
            {copy.privacyPoints.map((point) => <ListItem key={point} label={<>{point}</>} />)}
          </List>
        </SettingsSection>
      ) : null}
    </SettingsPage>
  );
}
