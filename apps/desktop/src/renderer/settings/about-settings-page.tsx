import { useEffect, useId, useState } from 'react';
import { Card } from '@astryxdesign/core';
import { Sparkles } from '@maka/ui/icons';
import {
  Button,
  PageHeader,
  SectionHeader,
  useMountedRef,
  useToast,
  useUiLocale,
  Banner,
} from '@maka/ui';
import { SettingRow } from './settings-rows';
import { settingsActionErrorMessage } from './settings-error-copy';
import { SettingsSkeletonStack } from './settings-skeleton';
import { useActionGuard } from './use-action-guard';
import { getSettingsPreferencesCopy } from '../locales/settings-preferences-copy.js';

type AppInfo = Awaited<ReturnType<typeof window.maka.app.info>>;

const PLATFORM_LABEL: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
};

export function AboutSettingsPage() {
  const locale = useUiLocale();
  const copy = getSettingsPreferencesCopy(locale).about;
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [copyingEnvSummary, setCopyingEnvSummary] = useState(false);
  const envSummaryCopyGuard = useActionGuard<'copy'>();
  const aboutPageMountedRef = useMountedRef();
  const toast = useToast();
  const envSummaryHelpId = useId();

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
      <div className="settingsStructuredPage">
        <Banner
          status="info"
          role="alert"
          title={copy.unavailable}
          description={infoError} />
      </div>
    );
  }

  const platformPretty = PLATFORM_LABEL[info.platform] ?? info.platform;
  const platformLine = `${platformPretty} ${info.osRelease} · ${info.arch}`;

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
    <div className="settingsAboutPage">
      <PageHeader
        as_wrapper="div"
        className="settingsAboutHero"
        as="h2"
        icon={<Sparkles size={26} />}
        iconClassName="settingsAboutLogo"
        headingRowClassName="settingsAboutHeading"
        title="Maka"
        badge={
          <>
            <span className="settingsAboutVersion">v{info.appVersion}</span>
            <span className="settingsAboutChannel">
              {info.buildMode === 'dev'
                ? info.buildCommit
                  ? `${copy.devBuild} · ${info.buildCommit}`
                  : copy.devBuild
                : copy.packagedBuild}
            </span>
          </>
        }
        subtitle={copy.subtitle}
        subtitleClassName="settingsAboutTagline"
      />
      <section className="settingsPrivacyBlock" aria-label={copy.privacyLabel}>
        <SectionHeader as="h3" title={copy.privacyTitle} />
        <Banner
          status="info"
          title={<ul className="settingsPrivacyPoints">
            {copy.privacyPoints.map((point) => <li key={point}>{point}</li>)}
          </ul>} />
      </section>
      <Card padding={0} className="settingsRows">
        <SettingRow
          title={copy.runtime}
          detail={copy.runtimeDetail}
          value={`Electron ${info.electronVersion} · Node ${info.nodeVersion} · Chrome ${info.chromeVersion}`}
        />
        <SettingRow title={copy.platform} detail={copy.platformDetail} value={platformLine} />
        <SettingRow
          title={copy.workspace}
          detail={copy.workspaceDetail}
          value={info.workspacePath}
          mono
        />
        <SettingRow
          title={copy.storage}
          detail={copy.storageDetail}
          value={copy.local}
        />
      </Card>
      <div className="settingsActionRow">
        <Button variant="primary" isDisabled={copyingEnvSummary} aria-describedby={envSummaryHelpId} onClick={() => void copyEnvSummary()} label={copyingEnvSummary ? copy.copying : copy.copyEnvironment} />
      </div>
      <p id={envSummaryHelpId} className="settingsHelpText">
        {copy.copyHelp}
      </p>
    </div>
  );
}
