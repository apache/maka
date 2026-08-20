import { useEffect, useState } from 'react';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { Banner, Button, Spinner, useToast, useUiLocale } from '@maka/ui';
import type { RemoteRuntimeHostProfile } from '@maka/runtime-host/client';
import type {
  DesktopRuntimeHostManagementAction,
  DesktopRuntimeHostManagementSnapshot,
} from '../../preload/bridge-contract.js';
import { getSettingsProjectsCopy } from '../locales/settings-projects-copy.js';
import { settingsActionErrorMessage } from './settings-error-copy.js';

export function RuntimeHostManagementDialog(props: {
  readonly profile: RemoteRuntimeHostProfile | undefined;
  readonly onClose: () => void;
  readonly onRepair: (profile: RemoteRuntimeHostProfile) => void;
}) {
  const locale = useUiLocale();
  const copy = getSettingsProjectsCopy(locale).runtimeHost;
  const toast = useToast();
  const [snapshot, setSnapshot] = useState<DesktopRuntimeHostManagementSnapshot>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [logs, setLogs] = useState<string>();
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);

  const profile = props.profile;
  useEffect(() => {
    if (!profile) return;
    let disposed = false;
    setSnapshot(undefined);
    setError(undefined);
    setLogs(undefined);
    setConfirmingUninstall(false);
    setLoading(true);
    void window.maka.runtimeHostManagement.getStatus(profile.id).then(
      (next) => {
        if (!disposed) setSnapshot(next);
      },
      (failure) => {
        if (!disposed) setError(settingsActionErrorMessage(failure, locale));
      },
    ).finally(() => {
      if (!disposed) setLoading(false);
    });
    return () => {
      disposed = true;
    };
  }, [locale, profile]);

  async function run(action: DesktopRuntimeHostManagementAction): Promise<void> {
    if (!profile) return;
    setLoading(true);
    setError(undefined);
    try {
      const response = await window.maka.runtimeHostManagement.run(profile.id, action);
      if (response.kind === 'error') {
        setError(response.error.message);
        toast.error(copy.managementActionFailed, response.error.message);
        return;
      }
      const result = response;
      setSnapshot({
        kind: 'available',
        profileId: profile.id,
        profileName: profile.name,
        result,
      });
      if (action === 'logs') setLogs(result.logs ?? '');
    } catch (failure) {
      const message = settingsActionErrorMessage(failure, locale);
      setError(message);
      toast.error(copy.managementActionFailed, message);
    } finally {
      setLoading(false);
    }
  }

  const result = snapshot?.kind === 'available' ? snapshot.result : undefined;
  const service = result?.service;
  return (
    <Dialog
      isOpen={profile !== undefined}
      onOpenChange={(open) => {
        if (!open && !loading) props.onClose();
      }}
      purpose="form"
      width={640}
      maxHeight="calc(100dvh - 64px)"
    >
      <Layout
        header={(
          <DialogHeader
            title={profile ? copy.managementTitle(profile.name) : copy.title}
            subtitle={profile?.transport.kind === 'ssh' ? profile.transport.destination : undefined}
            onOpenChange={(open) => {
              if (!open && !loading) props.onClose();
            }}
          />
        )}
        content={(
          <LayoutContent padding={4}>
            <div className="settingsRuntimeHostManagement">
              {loading && !snapshot ? (
                <div className="settingsRuntimeHostSetupProgress" role="status">
                  <Spinner size="sm" />
                </div>
              ) : null}
              {error ? <Banner status="error" title={error} /> : null}
              {snapshot?.kind === 'failed' ? (
                <Banner status="error" title={snapshot.error.message} />
              ) : null}
              {snapshot?.kind === 'unavailable' ? (
                <Banner status="info" title={copy.managementUnavailable} />
              ) : null}
              {confirmingUninstall ? (
                <Banner
                  status="warning"
                  title={copy.uninstallConfirmTitle}
                  description={copy.uninstallConfirmBody}
                />
              ) : null}
              {service ? (
                <>
                  {result?.action === 'uninstall' && result.retainedStateRoot ? (
                    <Banner
                      status="success"
                      title={copy.uninstallRetained(result.retainedStateRoot)}
                    />
                  ) : null}
                  <dl className="settingsRuntimeHostManagementFacts">
                    <Fact label={copy.serviceStatus} value={copy.serviceState[service.state]} />
                    <Fact label={copy.installedVersion} value={service.installedVersion ?? '—'} />
                    <Fact
                      label={copy.operatingSystem}
                      value={`${service.platform} ${service.arch} · ${service.osRelease}`}
                    />
                    <Fact label={copy.processId} value={service.pid?.toString() ?? '—'} />
                    <Fact
                      label={copy.lastExitCode}
                      value={service.lastExitCode?.toString() ?? '—'}
                    />
                    {service.stateRoot ? (
                      <Fact label={copy.stateRoot} value={service.stateRoot} wide />
                    ) : null}
                  </dl>
                  <div className="settingsRuntimeHostManagementDirectoryRoots">
                    <Text type="body" weight="semibold">{copy.directoryRoots}</Text>
                    {service.projectDirectoryRoots.length > 0 ? (
                      <ul className="settingsRuntimeHostManagementRoots">
                        {service.projectDirectoryRoots.map((root) => (
                          <li key={`${root.label}:${root.path}`}>
                            <span>{root.label}</span>
                            <code>{root.path}</code>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <Text type="supporting" color="secondary">{copy.noDirectoryRoots}</Text>
                    )}
                  </div>
                  {logs !== undefined ? (
                    <pre className="settingsRuntimeHostManagementLogs">
                      {logs || copy.noLogs}
                    </pre>
                  ) : null}
                </>
              ) : null}
            </div>
          </LayoutContent>
        )}
        footer={(
          <LayoutFooter hasDivider>
            <div className="settingsRuntimeHostManagementActions">
              {confirmingUninstall ? (
                <>
                  <Button
                    variant="secondary"
                    label={copy.cancel}
                    isDisabled={loading}
                    onClick={() => setConfirmingUninstall(false)}
                  />
                  <Button
                    variant="destructive"
                    label={copy.uninstallConfirm}
                    isDisabled={loading}
                    clickAction={async () => {
                      await run('uninstall');
                      setConfirmingUninstall(false);
                    }}
                  />
                </>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    label={copy.setupDone}
                    isDisabled={loading}
                    onClick={props.onClose}
                  />
                  {profile?.transport.kind === 'ssh' ? (
                    <Button
                      variant="secondary"
                      label={copy.repairService}
                      isDisabled={loading}
                      onClick={() => props.onRepair(profile)}
                    />
                  ) : null}
                  {snapshot?.kind === 'available' && profile ? (
                    <>
                      <Button
                        variant="secondary"
                        label={copy.refresh}
                        isDisabled={loading}
                        clickAction={() => run('status')}
                      />
                      {service?.installed ? (
                        <Button
                          variant="secondary"
                          label={copy.showLogs}
                          isDisabled={loading}
                          clickAction={() => run('logs')}
                        />
                      ) : null}
                      {service?.installed && service.active ? (
                        <Button
                          variant="primary"
                          label={copy.restartService}
                          isDisabled={loading}
                          clickAction={() => run('restart')}
                        />
                      ) : service?.installed ? (
                        <Button
                          variant="primary"
                          label={copy.startService}
                          isDisabled={loading}
                          clickAction={() => run('start')}
                        />
                      ) : null}
                      {service?.installed ? (
                        <Button
                          variant="secondary"
                          label={copy.uninstallService}
                          isDisabled={loading}
                          onClick={() => setConfirmingUninstall(true)}
                        />
                      ) : null}
                    </>
                  ) : null}
                </>
              )}
            </div>
          </LayoutFooter>
        )}
      />
    </Dialog>
  );
}

function Fact(props: {
  readonly label: string;
  readonly value: string;
  readonly wide?: boolean;
}) {
  return (
    <div className={props.wide ? 'settingsRuntimeHostManagementFactWide' : undefined}>
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}
