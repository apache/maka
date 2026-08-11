import { useEffect, useId, useState } from 'react';
import { Badge, Link, List, ListItem } from '@astryxdesign/core';
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
import { SettingsActions, SettingsPage, SettingsSection } from './settings-section';
import { SettingRow } from './settings-rows';
import { settingsActionErrorMessage } from './settings-error-copy';
import { SettingsSkeletonStack } from './settings-skeleton';
import { useActionGuard } from './use-action-guard';
import { aboutUpdateStatusDetail } from './about-update-status.js';
import { getSettingsPreferencesCopy } from '../locales/settings-preferences-copy.js';
import { getSettingsSharedCopy } from '../locales/settings-shared-copy.js';

type AppInfo = Awaited<ReturnType<typeof window.maka.app.info>>;

const PLATFORM_LABEL: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
};

/** Where 复制环境信息 is meant to be pasted (owner msg `36501869`). */
const ISSUE_TRACKER_URL = 'https://github.com/maka-agent/maka-agent/issues';

export function AboutSettingsPage(props: { onOpenKeyboardHelp?(): void }) {
  const locale = useUiLocale();
  const copy = getSettingsPreferencesCopy(locale).about;
  const sharedCopy = getSettingsSharedCopy(locale);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [copyingEnvSummary, setCopyingEnvSummary] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const envSummaryCopyGuard = useActionGuard<'copy'>();
  const checkUpdateGuard = useActionGuard<'check'>();
  const aboutPageMountedRef = useMountedRef();
  const toast = useToast();
  const envSummaryHelpId = useId();
  const updateHelpId = useId();

  useEffect(() => {
    let cancelled = false;
    window.maka.app
      .info()
      .then((next) => {
        if (!cancelled) {
          setInfo(next);
          setInfoError(null);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        const message = settingsActionErrorMessage(error, locale);
        setInfoError(message);
        toast.error(copy.loadFailed, message);
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

  if (!info && !infoError) {
    return (
      <SettingsSkeletonStack
        label={copy.loading}
        lines={[
          { width: '38%', size: 'lg' },
          { width: '70%' },
          { width: '52%' },
        ]}
      />
    );
  }

  if (!info) {
    return (
      <SettingsPage>
        <Banner
          status="info"
          role="alert"
          title={copy.unavailable}
          description={infoError} />
      </SettingsPage>
    );
  }

  const platformPretty = PLATFORM_LABEL[info.platform] ?? info.platform;

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

  async function copyEnvSummary() {
    if (!info) return;
    if (!envSummaryCopyGuard.begin('copy')) return;
    setCopyingEnvSummary(true);
    // Markdown block ready to paste into a problem report. Deliberately excludes
    // workspacePath since that can leak the OS username; user can still copy
    // it from the Data page if needed.
    const buildLine =
      info.buildMode === 'dev'
        ? `- Build: dev${info.buildCommit ? ` @ ${info.buildCommit}` : ''}`
        : '- Build: packaged';
    const summary = [
      `**Maka** v${info.appVersion}`,
      ``,
      `- Electron: ${info.electronVersion}`,
      `- Node: ${info.nodeVersion}`,
      `- Chrome: ${info.chromeVersion}`,
      `- Platform: ${platformPretty} ${info.osRelease}`,
      `- Arch: ${info.arch}`,
      buildLine,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(summary);
      if (aboutPageMountedRef.current) {
        toast.success(copy.copied, copy.pasteHint);
      }
    } catch {
      if (aboutPageMountedRef.current) {
        toast.error(copy.copyFailed, copy.clipboardUnavailable);
      }
    } finally {
      envSummaryCopyGuard.finish();
      if (aboutPageMountedRef.current) {
        setCopyingEnvSummary(false);
      }
    }
  }

  return (
    <SettingsPage>
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
      {/* UX audit (owner msg `30f736ed`): this group used to print Electron /
          Node / Chrome, OS + arch, the workspace path, and "storage: local" as
          four readout rows. The only task any of it serves is "send my
          environment to a developer", and the 复制环境信息 button already does
          that task completely — the rows were the button's payload, spread out
          for the user to read and then not act on.

          The workspace path also had a second home on the 数据 page, which is
          the one that can actually open and copy it, and "storage: local" only
          repeated a line the privacy list above already makes.

          What is left is the version itself (in the hero above) and the one
          action. */}
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
      <SettingsSection title={sharedCopy.groups.buildInfo}>
        <SettingsActions>
          <Button variant="primary" isDisabled={copyingEnvSummary} aria-describedby={envSummaryHelpId} onClick={() => void copyEnvSummary()} label={copyingEnvSummary ? copy.copying : copy.copyEnvironment} />
          {/* The loop this button was always half of. Its help line has always
              said "paste it into an issue report", but nothing in the app said
              where — the old 问题反馈 menu item just reopened this page. Now
              copy, open, paste. */}
          <Link href={ISSUE_TRACKER_URL} target="_blank" rel="noreferrer noopener">{copy.reportIssueLabel}</Link>
          <p id={envSummaryHelpId}>
            {copy.copyHelp}
          </p>
        </SettingsActions>
      </SettingsSection>
    </SettingsPage>
  );
}
