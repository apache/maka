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
import {
  Badge,
  Divider,
  Grid,
  Heading,
  HStack,
  Link,
  List,
  ListItem,
  MetadataList,
  MetadataListItem,
  Text,
  VStack,
} from '@astryxdesign/core';
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
import { SettingsPage } from './settings-section.js';
import { settingsActionErrorMessage } from './settings-error-copy.js';
import { SettingsSkeletonStack } from './settings-skeleton.js';
import { useActionGuard } from './use-action-guard.js';
import { aboutChannelBadge, aboutUpdateStatusDetail } from './about-update-status.js';
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
  const diagnosticsHelpId = useId();
  const updateHelpId = useId();
  const updatesHeadingId = useId();
  const supportHeadingId = useId();
  const privacyHeadingId = useId();

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
    const channelBadge = aboutChannelBadge(info, copy);
    const channelKey = info.buildMode === 'dev' ? 'dev' : info.updateChannel;
    const isDevBuild = info.buildMode === 'dev';
    // The contract hands us `homePath` for exactly this collapse.
    const workspaceDisplay = info.workspacePath.startsWith(info.homePath)
      ? `~${info.workspacePath.slice(info.homePath.length)}`
      : info.workspacePath;
    aboutContent = (
      <>
        <VStack gap={5}>
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
                <Badge variant={channelBadge.variant} label={channelBadge.label} />
              </>
            }
            subtitle={copy.subtitle}
            subtitleClassName="settingsAboutTagline"
          />
          {/* The archive readout: what channel this is, what it runs on, and
              where the data lives. Astryx's label → value primitive, the same
              construction the MCP detail panel uses — no hairlines of ours. */}
          <MetadataList columns="single" label={{ position: 'start', width: 88 }}>
            <MetadataListItem label={copy.channelLabel}>
              <Text type="body">
                {channelBadge.channelName} · {copy.channelSummaries[channelKey]}
              </Text>
            </MetadataListItem>
            <MetadataListItem label={copy.runtimeLabel}>
              <Text type="body">
                {copy.platformNames[info.platform] ?? info.platform} · {info.arch} · Electron {info.electronVersion}
              </Text>
            </MetadataListItem>
            <MetadataListItem label={copy.workspaceLabel}>
              <Text type="body"><code>{workspaceDisplay}</code></Text>
            </MetadataListItem>
          </MetadataList>
        </VStack>
        <Divider />
        <section aria-labelledby={updatesHeadingId}>
          <Grid columns={{ minWidth: 320, max: 2, repeat: 'fit' }} gap={10}>
            <VStack gap={1}>
              <Heading level={3} id={updatesHeadingId}>{copy.updatesTitle}</Heading>
              <Text type="supporting" size="sm" color="secondary">{copy.updatesLede}</Text>
            </VStack>
            <VStack gap={2}>
              {/* A dev build's status detail IS the explanation (本地开发版不检查
                  GitHub 发布更新…), so the background-check paragraph must not
                  repeat it — the old page printed that sentence twice. */}
              <Text type="body" id={isDevBuild ? updateHelpId : undefined}>
                {aboutUpdateStatusDetail(updateStatus, copy, { isDevBuild })}
              </Text>
              {!isDevBuild && (
                <Text type="supporting" size="sm" color="secondary" id={updateHelpId}>
                  {copy.updateHelp}
                </Text>
              )}
              <HStack gap={2}>
                <Button
                  variant="secondary"
                  size="sm"
                  isDisabled={checkingUpdate || isDevBuild}
                  aria-describedby={updateHelpId}
                  onClick={() => void checkForUpdates()}
                  label={checkingUpdate || updateStatus?.state === 'checking'
                    ? copy.checkingForUpdates
                    : copy.checkForUpdates}
                />
              </HStack>
            </VStack>
          </Grid>
        </section>
        <Divider />
      </>
    );
  }

  return (
    <SettingsPage>
      {aboutContent}
      {/* Support lives OUTSIDE the info conditional on purpose: copying
          diagnostics must not depend on `app.info` succeeding — that is the
          very moment a user needs it. The keyboard sheet used to be reachable
          only from the titlebar's `…` drawer and two shortcuts, which made
          the panel listing the shortcuts openable only by shortcut; this is
          the entry a mouse can find. */}
      <section aria-labelledby={supportHeadingId}>
        <Grid columns={{ minWidth: 320, max: 2, repeat: 'fit' }} gap={10}>
          <VStack gap={1}>
            <Heading level={3} id={supportHeadingId}>{copy.supportTitle}</Heading>
            <Text type="supporting" size="sm" color="secondary">{copy.supportLede}</Text>
          </VStack>
          <VStack gap={5}>
            <VStack gap={1} align="start">
              <Text type="label">{copy.copyDiagnostics}</Text>
              <Text type="supporting" size="sm" color="secondary" id={diagnosticsHelpId}>
                {copy.copyHelp}
              </Text>
              <HStack gap={2}>
                <Button
                  variant="primary"
                  size="sm"
                  isDisabled={copyingDiagnostics}
                  aria-describedby={diagnosticsHelpId}
                  onClick={() => void copyDiagnostics()}
                  label={copyingDiagnostics ? copy.copying : copy.copyAction}
                />
                <Kbd keys="mod+shift+d" />
              </HStack>
            </VStack>
            <VStack gap={1} align="start">
              <Text type="label">{copy.reportIssueLabel}</Text>
              <Text type="supporting" size="sm" color="secondary">{copy.reportIssueHelp}</Text>
              <HStack gap={2}>
                <Link href={ISSUE_TRACKER_URL} target="_blank" rel="noreferrer noopener">
                  {copy.reportIssueOpen}
                </Link>
              </HStack>
            </VStack>
            {props.onOpenKeyboardHelp && (
              <VStack gap={1} align="start">
                <Text type="label">{copy.keyboardShortcuts}</Text>
                <Text type="supporting" size="sm" color="secondary">{copy.keyboardShortcutsHelp}</Text>
                <HStack gap={2}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={props.onOpenKeyboardHelp}
                    label={copy.keyboardShortcutsOpen}
                  />
                </HStack>
              </VStack>
            )}
          </VStack>
        </Grid>
      </section>
      {info && (
        <>
          <Divider />
          <section aria-labelledby={privacyHeadingId}>
            <Grid columns={{ minWidth: 320, max: 2, repeat: 'fit' }} gap={10}>
              <VStack gap={1}>
                <Heading level={3} id={privacyHeadingId}>{copy.privacyTitle}</Heading>
                <Text type="supporting" size="sm" color="secondary">{copy.privacyLede}</Text>
              </VStack>
              <List aria-label={copy.privacyLabel} density="compact" listStyle="disc">
                {/* Fragment-wrapped: ListItem single-line-truncates STRING labels,
                    and a privacy commitment must wrap, not ellipsize. */}
                {copy.privacyPoints.map((point) => <ListItem key={point} label={<>{point}</>} />)}
              </List>
            </Grid>
          </section>
        </>
      )}
    </SettingsPage>
  );
}